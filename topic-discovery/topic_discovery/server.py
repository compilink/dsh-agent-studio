import json, time
from pathlib import Path
from http.server import HTTPServer,BaseHTTPRequestHandler
from urllib.parse import urlsplit,parse_qs
from .store import Store

def serve(db_path,port=4332):
    dashboard=Path(__file__).resolve().parent.parent/'dashboard'
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def do_GET(self):
            # Loopback binding plus Host validation to prevent DNS rebinding.
            if self.headers.get('Host','').split(':')[0] not in ('127.0.0.1','localhost'):
                self.send_error(403);return
            p=urlsplit(self.path); q=parse_qs(p.query);store=Store(db_path)
            try:
                if p.path=='/api/runs':data={'runs':store.runs()}
                elif p.path.startswith('/api/runs/'):data=store.run(p.path.split('/')[-1])
                elif p.path=='/api/candidates':data={'candidates':store.artifacts('candidate',q.get('run_id',[None])[0])}
                elif p.path.startswith('/api/artifacts/'):
                    aid=p.path.split('/')[-1]; data=next((a for a in store.artifacts() if a['artifact_id']==aid),None)
                    if data is None:raise KeyError(aid)
                elif p.path=='/api/events':data={'events':store.events(q.get('run_id',[None])[0],int(q.get('after',['0'])[0]))}
                elif p.path=='/api/stream':
                    after=int(self.headers.get('Last-Event-ID') or q.get('after',['0'])[0]);rid=q.get('run_id',[None])[0]
                    self.send_response(200);self.send_header('Content-Type','text/event-stream');self.send_header('Cache-Control','no-cache');self.end_headers()
                    # Bound each stream; browser EventSource resumes with Last-Event-ID.
                    for _ in range(30):
                        for e in store.events(rid,after):
                            self.wfile.write(('id: '+str(e['sequence'])+'\ndata: '+json.dumps(e)+'\n\n').encode());after=e['sequence']
                        self.wfile.write(b': heartbeat\n\n');self.wfile.flush();time.sleep(1)
                    return
                elif p.path.startswith('/api/'):
                    self.send_error(404);return
                else:
                    filename=p.path.removeprefix('/dashboard/').lstrip('/') or 'index.html';file=(dashboard/filename).resolve()
                    if dashboard.resolve() not in file.parents or not file.is_file():self.send_error(404);return
                    body=file.read_bytes();mime='text/html' if file.suffix=='.html' else 'text/javascript' if file.suffix in ('.js','.mjs') else 'text/css' if file.suffix=='.css' else 'application/octet-stream'
                    self.send_response(200);self.send_header('Content-Type',mime);self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(body);return
                body=json.dumps(data,ensure_ascii=False).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(body)
            except (KeyError,ValueError):self.send_error(404)
            except (BrokenPipeError,ConnectionResetError):pass
            finally:store.db.close()
    from http.server import ThreadingHTTPServer
    print(f'Topic dashboard: http://127.0.0.1:{port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
