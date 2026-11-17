"""Servidor local de vista previa: sirve esta carpeta y reenvía /wp-json/wc/store/* (solo GET)
a digitalmtx.com, imitando el mismo origen que tendrá la página en producción.
Si el sitio no responde (por ejemplo, desafío anti-bots de Cloudflare a clientes que no son
navegadores), sirve la última respuesta guardada en .cache/. POST /__cache?key=<ruta> guarda
una respuesta tomada desde un navegador real.
Uso: python navidad-tienda/dev-server.py [puerto]   (solo desarrollo, no se sube al hosting)"""
import hashlib, http.server, os, sys, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, ".cache")
UPSTREAM = "https://digitalmtx.com"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8793
os.makedirs(CACHE, exist_ok=True)


def cache_file(key):
    return os.path.join(CACHE, hashlib.sha1(key.encode()).hexdigest() + ".json")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def reply(self, status, body, ctype="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/wp-json/wc/store/"):
            req = urllib.request.Request(UPSTREAM + self.path, headers={"User-Agent": "Mozilla/5.0"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    body = r.read()
                with open(cache_file(self.path), "wb") as f:
                    f.write(body)
                return self.reply(200, body)
            except Exception as e:
                try:
                    with open(cache_file(self.path), "rb") as f:
                        return self.reply(200, f.read())
                except OSError:
                    return self.reply(502, str(e).encode(), "text/plain")
        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/__cache?"):
            key = urllib.parse.parse_qs(self.path.split("?", 1)[1]).get("key", [""])[0]
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            with open(cache_file(key), "wb") as f:
                f.write(body)
            return self.reply(204, b"")
        self.reply(404, b"")


http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
