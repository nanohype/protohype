"""
Agent Memory Client
===================
Drop this file into any agent session to read/write the shared memory service.

Usage:
    from memory_client import MemoryClient

    client = MemoryClient()  # defaults to localhost:8765

    # Write a memory
    client.write("eng-backend", "Chose SQLite WAL mode for zero-ops deployment.", ["decision", "database"])

    # Search memories
    results = client.search("what database did we choose and why?")
    for r in results:
        print(f"[{r['role']}] (score={r['score']:.2f}) {r['content']}")

    # List recent
    recent = client.recent(limit=10)

    # Health check
    print(client.health())
"""
import json
import os
import urllib.request
import urllib.error
from typing import Optional


class MemoryClient:
    def __init__(self, base_url: str | None = None, api_key: str | None = None, timeout: int = 10):
        self.base_url = (base_url or os.environ.get("AGENT_MEMORY_URL", "http://127.0.0.1:8765")).rstrip("/")
        self.api_key = api_key or os.environ.get("AGENT_MEMORY_API_KEY")
        self.timeout = timeout

    def write(self, role: str, content: str, tags: list[str] | None = None) -> dict:
        payload = {"role": role, "content": content, "tags": tags or []}
        return self._post("/api/v1/memories", payload, expected_status=201)

    def search(self, query: str, top_k: int = 5, role_filter: str | None = None, tag_filter: str | None = None) -> list[dict]:
        payload = {"query": query, "top_k": top_k, "role_filter": role_filter, "tag_filter": tag_filter}
        resp = self._post("/api/v1/memories/search", payload)
        return resp.get("results", [])

    def recent(self, limit: int = 20, offset: int = 0, role: str | None = None, tag: str | None = None) -> list[dict]:
        params = f"limit={limit}&offset={offset}"
        if role:
            params += f"&role={urllib.parse.quote(role)}"
        if tag:
            params += f"&tag={urllib.parse.quote(tag)}"
        resp = self._get(f"/api/v1/memories?{params}")
        return resp.get("memories", [])

    def delete(self, memory_id: str) -> bool:
        try:
            self._request("DELETE", f"/api/v1/memories/{memory_id}", expected_status=204)
            return True
        except MemoryClientError as e:
            if "404" in str(e):
                return False
            raise

    def health(self) -> dict:
        return self._get("/api/v1/health")

    def summarize(self) -> dict:
        return self._post("/api/v1/memories/summarize", {})

    def load_context(self, query: str, top_k: int = 10) -> str:
        results = self.search(query, top_k=top_k)
        if not results:
            return "(No relevant memories found)"
        lines = [f"AGENT MEMORY — relevant to: {query!r}\n"]
        for i, r in enumerate(results, 1):
            m = r["memory"]
            score = r["score"]
            lines.append(f"{i}. [{m['role']}] (relevance={score:.2f})\n   {m['content']}\n   tags: {', '.join(m['tags']) if m['tags'] else 'none'} | {m['created_at'][:10]}")
        return "\n".join(lines)

    def _get(self, path: str) -> dict:
        return self._request("GET", path)

    def _post(self, path: str, payload: dict, expected_status: int = 200) -> dict:
        return self._request("POST", path, payload, expected_status)

    def _request(self, method: str, path: str, payload: dict | None = None, expected_status: int = 200) -> dict:
        url = self.base_url + path
        data = json.dumps(payload).encode() if payload is not None else None
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                status = resp.status
                body = resp.read().decode()
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            raise MemoryClientError(f"HTTP {e.code} {method} {path}: {body}") from e
        except urllib.error.URLError as e:
            raise MemoryClientError(f"Cannot reach agent-memory at {self.base_url}: {e.reason}. Is the service running? See deploy/install.sh") from e
        if status != expected_status:
            raise MemoryClientError(f"Expected {expected_status}, got {status}: {body}")
        if body and method != "DELETE":
            return json.loads(body)
        return {}


class MemoryClientError(Exception):
    pass


if __name__ == "__main__":
    import sys
    import urllib.parse
    client = MemoryClient()
    if len(sys.argv) < 2:
        print("Usage:")
        print("  python memory_client.py health")
        print("  python memory_client.py search <query>")
        print("  python memory_client.py recent [limit]")
        print("  python memory_client.py write <role> <content> [tag1,tag2]")
        sys.exit(0)
    cmd = sys.argv[1]
    if cmd == "health":
        import pprint
        pprint.pprint(client.health())
    elif cmd == "search":
        if len(sys.argv) < 3:
            print("Usage: python memory_client.py search <query>")
            sys.exit(1)
        print(client.load_context(" ".join(sys.argv[2:])))
    elif cmd == "recent":
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 10
        for m in client.recent(limit=limit):
            tags = ", ".join(m["tags"]) if m["tags"] else "no tags"
            print(f"[{m['created_at'][:10]}] [{m['role']}] [{tags}]\n  {m['content'][:120]}\n")
    elif cmd == "write":
        if len(sys.argv) < 4:
            print("Usage: python memory_client.py write <role> <content> [tag1,tag2]")
            sys.exit(1)
        tags = sys.argv[4].split(",") if len(sys.argv) > 4 else []
        m = client.write(sys.argv[2], sys.argv[3], tags)
        print(f"Written: {m['id']}")
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)
