"""DeepEval bridge to the real NexusRAG TypeScript app.

The eval suite exercises the production HTTP entry point
(POST /api/chat, non-streaming JSON transport) so scores reflect the real
Mastra/router/retrieval/critic pipeline, not a reimplementation.

Tracing: run_traced_ai_app is wrapped in DeepEval's @observe, so each eval
produces a trace span carrying the input and the app's reply; the suite
asserts on the Golden against that trace (single-turn tracing shape). The
backend independently keeps the full run history (AnswerTraceRepository,
GET /api/chat/runs/:runId) for failure inspection.

Scope: each Golden carries its retrieval scope in additional_metadata
(see convert_demo_gate.mts). [] is an explicitly empty scope (must refuse);
a missing scope omits knowledgeBaseIds (server default scope).

Required runtime: backend on NEXUSRAG_BASE_URL (default
http://localhost:3001) with Elasticsearch + Neo4j reachable and demo data
seeded (npm run demo:seed).
"""

import os
import uuid
from pathlib import Path

import requests
from deepeval.tracing import observe, update_current_trace

BASE_URL = os.environ.get("NEXUSRAG_BASE_URL", "http://localhost:3001").rstrip("/")
TIMEOUT_SECONDS = int(os.environ.get("NEXUSRAG_CHAT_TIMEOUT_S", "300"))

# Published as the trace retrieval_context when the app returns no
# references. DeepEval rejects a None retrieval_context for Grounding, and
# `current_trace.retrieval_context or golden.retrieval_context` coerces an
# empty list to None during trace materialization, so refusal cases would
# error out with MissingTestCaseParamsError instead of being judged. The
# marker lets the judge see "nothing was retrieved" and rule on how the
# reply handles that (admits_gap_or_refuses / no_knowledge_needed).
NO_EVIDENCE_MARKER = (
    "(no documents retrieved - the app returned no references for this query)"
)


def _dot_env(key: str) -> str:
    """Read one key from the repo-root .env (gitignored local secrets)."""
    env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip()
    except OSError:
        pass
    return ""


_token: str | None = None


def _auth_headers() -> dict:
    """Log in once as the demo admin (demo tenant) and cache the token."""
    global _token
    if _token is None:
        password = os.environ.get("DEMO_OIDC_PASSWORD") or _dot_env("DEMO_OIDC_PASSWORD")
        if not password:
            raise RuntimeError("DEMO_OIDC_PASSWORD is not set; cannot sign in to the demo tenant")
        resp = requests.post(
            f"{BASE_URL}/api/auth/login",
            json={"account": "admin", "password": password},
            timeout=30,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"demo sign-in failed: HTTP {resp.status_code}: {resp.text[:300]}")
        _token = resp.json().get("accessToken", "")
        if not _token:
            raise RuntimeError("demo sign-in returned no accessToken")
    return {"Authorization": f"Bearer {_token}"}


def _post_chat(message: str, session_id: str, scope) -> dict:
    body: dict = {
        "message": message,
        "stream": False,
        "sessionId": session_id,
    }
    if scope is not None:
        body["knowledgeBaseIds"] = scope
    try:
        response = requests.post(
            f"{BASE_URL}/api/chat",
            json=body,
            headers=_auth_headers(),
            timeout=TIMEOUT_SECONDS,
        )
    except requests.RequestException as exc:
        raise RuntimeError(f"chat backend unreachable at {BASE_URL}: {exc}") from exc
    if response.status_code != 200:
        raise RuntimeError(
            f"chat backend returned HTTP {response.status_code}: "
            f"{response.text[:500]}"
        )
    return response.json()


@observe(type="agent")
def run_traced_ai_app(golden) -> str:
    """Run one Golden through the real app inside a trace span; return reply."""
    meta = getattr(golden, "additional_metadata", None) or {}
    scope = meta.get("scope")
    session_id = str(uuid.uuid4())
    payload = _post_chat(golden.input, session_id, scope)
    reply = payload.get("reply", "")
    if not isinstance(reply, str) or not reply.strip():
        raise RuntimeError(f"chat backend returned an empty reply: {payload!r}"[:500])
    # Publish the app's evidence to the trace so grounding judgments can
    # compare the reply against what was actually retrieved (Jeveval reads
    # trace.retrieval_context into the materialized test case).
    references = payload.get("references") or []
    evidence = []
    for ref in references:
        if not isinstance(ref, dict):
            continue
        rid = ref.get("id", "?")
        title = ref.get("title", "")
        excerpt = (ref.get("excerpt", "") or "")[:600]
        evidence.append(f"[{rid}] {title}: {excerpt}".strip())
    update_current_trace(
        retrieval_context=evidence if evidence else [NO_EVIDENCE_MARKER],
        metadata={
            "run_id": payload.get("runId"),
            "run_status": payload.get("status"),
            "scope": scope,
        },
    )
    return reply
