"""
Minimal OpenAI-compatible API server wrapping a HuggingFace model.

Serves the training model locally so OMA's harness can call it.
Supports hot-reloading weights after each training epoch.

Usage:
    python model_server.py --model Qwen/Qwen2.5-0.5B-Instruct --port 8000

    # Then configure OMA agent with:
    #   model: "qwen"
    #   model_base_url: "http://localhost:8000/v1"
    #   model_compat: "oai-compatible"
"""

import argparse
import json
import time
import uuid
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

import torch
from transformers import AutoTokenizer, AutoModelForCausalLM
from peft import PeftModel


def get_device():
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


class ModelState:
    def __init__(self, model_name: str):
        self.device = get_device()
        self.tokenizer = AutoTokenizer.from_pretrained(model_name, trust_remote_code=True)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        dtype = torch.float32
        self.model = AutoModelForCausalLM.from_pretrained(
            model_name, torch_dtype=dtype, trust_remote_code=True,
        )
        self.model.to(self.device)
        self.model.eval()
        self.model_name = model_name
        self.version = 0
        self.lock = threading.Lock()

        params = sum(p.numel() for p in self.model.parameters())
        print(f"[server] {model_name} loaded on {self.device} ({params/1e6:.0f}M params)")

    def reload_lora(self, lora_path: str):
        with self.lock:
            self.model = PeftModel.from_pretrained(
                self.model.base_model if hasattr(self.model, 'base_model') else self.model,
                lora_path,
            )
            self.model.to(self.device)
            self.model.eval()
            self.version += 1
            print(f"[server] Reloaded LoRA from {lora_path} (v{self.version})")

    def generate(self, messages: list[dict], max_tokens: int = 1024, temperature: float = 0.7, stop: list[str] = None):
        with self.lock:
            text = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            inputs = self.tokenizer(text, return_tensors="pt", truncation=True, max_length=2048).to(self.device)
            prompt_len = inputs.input_ids.shape[1]

            with torch.no_grad():
                outputs = self.model.generate(
                    **inputs,
                    max_new_tokens=max_tokens,
                    temperature=max(temperature, 0.01),
                    do_sample=temperature > 0,
                    pad_token_id=self.tokenizer.pad_token_id,
                )

            response_ids = outputs[0][prompt_len:]
            response_text = self.tokenizer.decode(response_ids, skip_special_tokens=True)

            if stop:
                for s in stop:
                    if s in response_text:
                        response_text = response_text[:response_text.index(s)]

            return response_text, len(response_ids)


state: ModelState = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # suppress default logging

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/v1/models":
            self._send_json({
                "data": [{"id": state.model_name, "object": "model", "owned_by": "local"}]
            })
        elif self.path == "/health" or self.path == "/":
            self._send_json({"status": "ok", "version": state.version})
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if self.path == "/v1/chat/completions":
            self._handle_chat(body)
        elif self.path == "/v1/completions":
            self._handle_completion(body)
        elif self.path == "/reload":
            lora_path = body.get("lora_path", "")
            if lora_path:
                state.reload_lora(lora_path)
                self._send_json({"status": "reloaded", "version": state.version})
            else:
                self._send_json({"error": "lora_path required"}, 400)
        else:
            self._send_json({"error": "not found"}, 404)

    def _handle_chat(self, body: dict):
        messages = body.get("messages", [])
        max_tokens = body.get("max_tokens", 1024)
        temperature = body.get("temperature", 0.7)
        stop = body.get("stop", None)

        t0 = time.time()
        text, num_tokens = state.generate(messages, max_tokens, temperature, stop)
        duration = time.time() - t0
        print(f"[gen] {num_tokens} tokens in {duration:.1f}s ({num_tokens/max(duration,0.01):.0f} tok/s)")

        self._send_json({
            "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": state.model_name,
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": num_tokens,
                "total_tokens": num_tokens,
            },
        })

    def _handle_completion(self, body: dict):
        prompt = body.get("prompt", "")
        messages = [{"role": "user", "content": prompt}]
        max_tokens = body.get("max_tokens", 1024)
        temperature = body.get("temperature", 0.7)

        text, num_tokens = state.generate(messages, max_tokens, temperature)

        self._send_json({
            "id": f"cmpl-{uuid.uuid4().hex[:8]}",
            "object": "text_completion",
            "choices": [{"text": text, "index": 0, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 0, "completion_tokens": num_tokens, "total_tokens": num_tokens},
        })


def main():
    global state
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    state = ModelState(args.model)

    server = HTTPServer((args.host, args.port), Handler)
    print(f"[server] Listening on http://{args.host}:{args.port}")
    print(f"[server] OMA config: model_base_url=http://localhost:{args.port}/v1 model_compat=oai-compatible")
    print(f"[server] POST /reload {{\"lora_path\": \"...\"}} to hot-reload weights")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] Shutting down")
        server.server_close()


if __name__ == "__main__":
    main()
