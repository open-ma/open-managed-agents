import { describe, expect, it } from "vitest";
import OpenAI from "openai";
import { buildOpenAIAgentsProtocolApi } from "@open-managed-agents/openai-agents-api";
import { createSessionsHandler, type SessionSemanticDependencies } from "../src/sessions";
import { normalizeAgentConfig } from "../src/resources";

function fixture() {
  const native: any = { id: "session", agent: { id:"agent" }, createdAt: new Date(100000).toISOString(), updatedAt:new Date(101000).toISOString(), metadata:{purpose:"test"} };
  const events: any[] = [];
  const sent: any[] = [];
  let legacy = false;
  const deps: SessionSemanticDependencies = {
    workspaceId:"workspace",
    sessions: {
      createSession: async () => ({type:"created",session:native}),
      retrieveSession: async ({sessionId}) => sessionId === native.id ? {type:"found",session:native} : {type:"not_found"},
      updateSession: async command => { native.metadata = Object.fromEntries(Object.entries({...native.metadata,...command.metadata}).filter(([,v])=>v!==null)); return {type:"updated",session:native}; },
      listSessions: async () => ({type:"page",page:{sessions:[native],nextCursor:null,previousCursor:null}}),
      deleteSession: async ({sessionId}) => ({type:"deleted",sessionId}),
      archiveSession: async()=>({type:"not_found"}),
    },
    sessionEvents: {
      sendSessionEvents: async command => { sent.push(command); return {type:"accepted",events:[]}; },
      listSessionEvents: async()=>({type:"not_found"}), streamSessionEvents:async()=>({type:"not_found"}),
    },
    history: {loadSessionRuntimeHistory: async () => ({type:"found",revision:2,initialEvents:[{type:"user.message",content:[{type:"text",text:"hello"}]}],events:legacy ? events : [...events].reverse(),...(!legacy && {orderedEvents:events.map((event,index)=>({event,position:{revision:2,index}}))})})},
    mapping: {
      prepareCreate: async()=>({agent:{type:"latest",agentId:"agent"},environmentId:"env"}),
      sessionView: async s => { const {metadata:_metadata,...agent} = normalizeAgentConfig({model:"test",name:"Agent"}); return {id:s.id,object:"agent.session",created_at:100,last_active_at:101,agent:{...agent,id:"agent"},environment:{type:"none"},status:"idle",error:null,metadata:s.metadata,required_actions:[],usage:null,vault_ids:[]} as any; },
      prepareMetadata: async (s,metadata) => ({...Object.fromEntries(Object.keys(s.metadata).map(key=>[key,null])),...metadata}),
    }, pollMs:1,
  };
  const makeClient = () => { const app = buildOpenAIAgentsProtocolApi(createSessionsHandler(deps)); return new OpenAI({apiKey:"local",baseURL:"http://localhost/v1",maxRetries:0,fetch:async(i,n)=>app.fetch(new Request(i,n))}); };
  return {native,events,sent,deps,client:makeClient(),makeClient,legacy:()=>{legacy=true;}};
}
describe("outer Session semantic mapping",()=>{
  it("rebuilds stable turns and items solely from ordered native facts after adapter reconstruction",async()=>{
    const f=fixture();
    f.events.push({id:"z-running",type:"session.status_running",processedAt:new Date(100000).toISOString()},{id:"m-answer",type:"agent.message",content:[{type:"text",text:"world"}],processedAt:new Date(101000).toISOString()},{id:"a-done",type:"session.status_idle",stopReason:{type:"end_turn"},processedAt:new Date(101000).toISOString()});
    const first=await f.client.beta.agents.sessions.turns.list("session");
    expect(first.data).toHaveLength(1); expect(first.data[0]?.status).toBe("completed");
    expect((await f.makeClient().beta.agents.sessions.turns.list("session")).data).toEqual(first.data);
    const items=await f.client.beta.agents.sessions.items.list("session",{order:"asc"});
    expect(items.data.map(item=>item.turn_id)).toEqual([first.data[0]!.id,first.data[0]!.id]);
    expect(items.data[1]).toMatchObject({id:"m-answer",status:"completed",content:[{type:"output_text",text:"world"}]});
    expect((await f.client.beta.agents.sessions.update("session",{metadata:{replacement:"value"}})).metadata).toEqual({replacement:"value"});
  });
  it("maps waiting actions and validates function-result ownership before dispatch",async()=>{
    const f=fixture();f.events.push({id:"call",type:"agent.custom_tool_use",name:"lookup",input:{key:"x"}},{id:"wait",type:"session.status_idle",stopReason:{type:"requires_action",eventIds:["call"]}});
    const session=await f.client.beta.agents.sessions.retrieve("session");
    expect(session.status).toBe("requires_action");
    const action=session.required_actions[0]!; expect(action.type).toBe("function_call");
    if(action.type!=="function_call") throw new Error("expected function");
    await expect(f.client.beta.agents.sessions.events.create("session",{events:[{type:"agent.session.input.tool_result",turn_id:"foreign",call_id:"call",success:true,output:"bad"}]})).rejects.toMatchObject({status:400});
    expect(f.sent).toHaveLength(0);
    await f.client.beta.agents.sessions.events.create("session",{events:[{type:"agent.session.input.tool_result",turn_id:action.turn_id,call_id:action.call_id,success:false,error:"missing"}], "Idempotency-Key":"result-one"});
    expect(f.sent[0]).toMatchObject({sessionId:"session",idempotencyKey:"result-one",events:[{type:"user.custom_tool_result",customToolUseId:"call",isError:true,content:[{type:"text",text:"missing"}]}]});
  });
  it("does not invent a successful turn from ambiguous legacy ordering or from cancellation",async()=>{
    const f=fixture();f.events.push({id:"cancel",type:"user.interrupt"},{id:"done",type:"session.status_idle",stopReason:{type:"end_turn"}});
    expect((await f.client.beta.agents.sessions.turns.list("session")).data[0]!.status).toBe("cancelled");
    f.legacy();
    await expect(f.client.beta.agents.sessions.turns.list("session")).rejects.toMatchObject({status:409});
  });
  it("streams creation and factual full text through the official SDK, and disconnect only ends the subscription",async()=>{
    const f=fixture();
    f.events.push({id:"running",type:"session.status_running"},{id:"answer",type:"agent.message",content:[{type:"text",text:"complete"}]},{id:"done",type:"session.status_idle",stopReason:{type:"end_turn"}});
    const stream=await f.client.beta.agents.sessions.create({agent:{model:"test"},environment:{type:"none"},input:"hello",stream:true});
    const observed:any[]=[];
    for await(const event of stream){observed.push(event);if(event.type==="agent.session.idle")break;}
    expect(observed[0].type).toBe("agent.session.created");
    expect(observed).toContainEqual(expect.objectContaining({type:"agent.session.turn.output_text.done",text:"complete"}));
    expect(observed.some(event=>event.type==="agent.session.turn.output_text.delta")).toBe(false);
    expect(f.sent).toHaveLength(0);
    expect((await f.client.beta.agents.sessions.retrieve("session")).status).toBe("idle");
  });
  it("supports the official subscribe-before-input helper without replaying previous output",async()=>{
    const f=fixture();f.events.push({id:"old-output",type:"agent.message",content:[{type:"text",text:"old"}]},{id:"old-done",type:"session.status_idle",stopReason:{type:"end_turn"}});
    f.deps.sessionEvents.sendSessionEvents=async command=>{
      f.sent.push(command);
      const accepted=command.events.map((event,index)=>({...event,id:`new-input-${index}`,outcomeId:null,processedAt:null}));
      f.events.push(...accepted,{id:"new-running",type:"session.status_running"},{id:"new-output",type:"agent.message",content:[{type:"text",text:"new"}]},{id:"new-done",type:"session.status_idle",stopReason:{type:"end_turn"}});
      return {type:"accepted",events:[]};
    };
    const events:any[]=[];
    for await(const event of f.client.beta.agents.sessions.stream("session",{input:"next",idempotencyKey:"helper-one"}))events.push(event);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].idempotencyKey).toBe("helper-one");
    expect(events.filter(event=>event.type==="agent.session.turn.output_text.done").map(event=>event.text)).toEqual(["new"]);
    expect(events.at(-1).type).toBe("agent.session.idle");
  });
});
