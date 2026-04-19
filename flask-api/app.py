"""
AI Backend Builder — Flask API Proxy Server

Proxies AI requests from the VS Code extension to locally running
AI models (Ollama or compatible). Acts as a unified interface so
the extension doesn't need to handle multiple AI model APIs directly.

Endpoints:
  POST /api/generate  — Generate text from a local AI model
  GET  /api/health    — Health check
  GET  /api/models    — List available models

Usage:
  1. Ensure Ollama is running: `ollama serve`
  2. Install dependencies: `pip install -r requirements.txt`
  3. Run the server: `python app.py`
  4. Extension connects to http://localhost:5000
"""

import os
import json
import time
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)  # Allow requests from VS Code extension

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────

# Ollama API base URL (default: localhost:11434)
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434")

# Default models per agent role (can be overridden per request)
DEFAULT_MODELS = {
    "planner": os.getenv("PLANNER_MODEL", "mistral:7b"),
    "codegen": os.getenv("CODEGEN_MODEL", "codellama:13b"),
    "debug": os.getenv("DEBUG_MODEL", "mistral:7b"),
}

# Request timeout for Ollama API calls (seconds)
REQUEST_TIMEOUT = int(os.getenv("REQUEST_TIMEOUT", "120"))

# Server configuration
HOST = os.getenv("FLASK_HOST", "0.0.0.0")
PORT = int(os.getenv("FLASK_PORT", "5000"))


# ─────────────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/health", methods=["GET"])
def health_check():
    """Health check endpoint. Also verifies Ollama connectivity."""
    try:
        resp = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        ollama_status = "connected" if resp.ok else "unreachable"
    except requests.exceptions.RequestException:
        ollama_status = "unreachable"

    return jsonify({
        "status": "ok",
        "ollama": ollama_status,
        "ollama_url": OLLAMA_URL,
        "timestamp": time.time(),
    })


@app.route("/api/models", methods=["GET"])
def list_models():
    """List available models from Ollama."""
    try:
        resp = requests.get(f"{OLLAMA_URL}/api/tags", timeout=10)
        if resp.ok:
            data = resp.json()
            models = [m.get("name", "unknown") for m in data.get("models", [])]
            return jsonify({
                "models": models,
                "default_models": DEFAULT_MODELS,
            })
        else:
            return jsonify({"error": f"Ollama returned {resp.status_code}"}), 502
    except requests.exceptions.RequestException as e:
        return jsonify({"error": f"Cannot reach Ollama: {str(e)}"}), 503


@app.route("/api/generate", methods=["POST"])
def generate():
    """
    Generate text from a local AI model.

    Expected JSON body:
    {
        "model": "string — model name (e.g., 'mistral:7b')",
        "prompt": "string — the user/task prompt",
        "system": "string — optional system prompt",
        "temperature": 0.3,      (optional, default: 0.3)
        "max_tokens": 4096       (optional, default: 4096)
    }

    Returns:
    {
        "response": "string — the generated text",
        "model": "string — model used",
        "done": true
    }
    """
    # Validate request
    if not request.is_json:
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()

    model = data.get("model")
    prompt = data.get("prompt")
    system_prompt = data.get("system", "")

    if not model:
        return jsonify({"error": "Missing 'model' field"}), 400

    if not prompt:
        return jsonify({"error": "Missing 'prompt' field"}), 400

    # Build Ollama request
    ollama_payload = {
        "model": model,
        "prompt": prompt,
        "system": system_prompt,
        "stream": False,  # Wait for complete response
        "options": {
            "temperature": data.get("temperature", 0.3),
            "num_predict": data.get("max_tokens", 4096),
        },
    }

    app.logger.info(f"Generating with model '{model}' (prompt: {len(prompt)} chars)")

    try:
        # Forward to Ollama
        resp = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json=ollama_payload,
            timeout=REQUEST_TIMEOUT,
        )

        if not resp.ok:
            error_text = resp.text[:500]
            app.logger.error(f"Ollama error ({resp.status_code}): {error_text}")
            return jsonify({
                "error": f"Ollama returned {resp.status_code}: {error_text}"
            }), 502

        result = resp.json()

        response_text = result.get("response", "")

        if not response_text:
            return jsonify({"error": "Ollama returned empty response"}), 502

        app.logger.info(
            f"Generated {len(response_text)} chars with model '{model}'"
        )

        return jsonify({
            "response": response_text,
            "model": model,
            "done": result.get("done", True),
        })

    except requests.exceptions.Timeout:
        app.logger.error(f"Ollama request timed out after {REQUEST_TIMEOUT}s")
        return jsonify({
            "error": f"Request timed out after {REQUEST_TIMEOUT} seconds"
        }), 504

    except requests.exceptions.ConnectionError:
        app.logger.error(f"Cannot connect to Ollama at {OLLAMA_URL}")
        return jsonify({
            "error": f"Cannot connect to Ollama at {OLLAMA_URL}. Is Ollama running?"
        }), 503

    except requests.exceptions.RequestException as e:
        app.logger.error(f"Ollama request failed: {str(e)}")
        return jsonify({"error": f"Request failed: {str(e)}"}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Error Handlers
# ─────────────────────────────────────────────────────────────────────────────

@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Endpoint not found"}), 404


@app.errorhandler(500)
def internal_error(e):
    return jsonify({"error": "Internal server error"}), 500


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"╔══════════════════════════════════════════════════════╗")
    print(f"║  AI Backend Builder — Flask API Proxy                ║")
    print(f"║  Ollama URL:  {OLLAMA_URL:<39} ║")
    print(f"║  Server:      http://{HOST}:{PORT:<24} ║")
    print(f"║  Models:                                             ║")
    print(f"║    Planner:   {DEFAULT_MODELS['planner']:<39} ║")
    print(f"║    CodeGen:   {DEFAULT_MODELS['codegen']:<39} ║")
    print(f"║    Debug:     {DEFAULT_MODELS['debug']:<39} ║")
    print(f"╚══════════════════════════════════════════════════════╝")

    app.run(host=HOST, port=PORT, debug=True)
