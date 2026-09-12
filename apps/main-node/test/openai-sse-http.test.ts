import { describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import OpenAI from "openai";
import { buildOpenAIAgentsProtocolApi } from "@open-managed-agents/openai-agents-api";

describe("OpenAI SDK over an actual Node HTTP connection", () => {
  it("flushes the SSE subscription before the SDK submits its input", async () => {
    const session: any = {id:"session",object:"agent.session",created_at:1,last_active_at:1,agent:{id:"agent",name:null,model:"test",instructions:null,reasoning:{effort:null,summary:null},service_tier:"auto",multi_agent:{enabled:false,max_concurrent_subagents:null},text:{format:{type:"text"},verbosity:"medium"},tools:[]},environment:{type:"none"},status:"idle",error:null,metadata:{},required_actions:[],usage:null,vault_ids:[]};
    const turn = {id:"turn",object:"agent.session.turn",session_id:"session",agent_id:"agent",subagent_id:null,created_at:1,started_at:1,completed_at:2,status:"completed",error:null,usage:null};
    const calls:string[]=[];
    let release:()=>void = () => {};
    const input = new Promise<void>(resolve=>{release=resolve;});
    const app=buildOpenAIAgentsProtocolApi({async execute(request){
      calls.push(request.operation);
      if(request.operation==="sessions.retrieve") return {body:session};
      if(request.operation==="sessions.events.create") {release();return {status:204};}
      return {stream:(async function*(){
        await input;
        yield {type:"agent.session.turn.created",event_id:"created",session_id:"session",turn_id:"turn",turn:{...turn,completed_at:null,status:"queued"}};
        yield {type:"agent.session.turn.completed",event_id:"completed",session_id:"session",turn_id:"turn",turn,usage:null};
        yield {type:"agent.session.idle",event_id:"idle",session};
      })()};
    }});
    const server=serve({fetch:app.fetch,hostname:"127.0.0.1",port:0});
    if(!server.listening) await new Promise<void>(resolve=>server.once("listening",resolve));
    const address=server.address();if(!address || typeof address==="string") throw new Error("Missing HTTP port");
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),1500);
    try {
      const client=new OpenAI({apiKey:"local-test",baseURL:`http://127.0.0.1:${address.port}/v1`,maxRetries:0});
      const events:string[]=[];
      for await(const event of client.beta.agents.sessions.stream("session",{input:"hello"},{signal:controller.signal}))events.push(event.type);
      expect(calls).toEqual(["sessions.retrieve","sessions.events.stream","sessions.events.create"]);
      expect(events.at(-1)).toBe("agent.session.idle");
    } finally {
      clearTimeout(timeout);controller.abort();release();server.closeAllConnections();
      await new Promise<void>(resolve=>server.close(()=>resolve()));
    }
  });
});
