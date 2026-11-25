import argparse,json,time,sys
from pathlib import Path
from .store import Store,utcnow
from .pipeline import run_pipeline
from .sources import FEEDS,fetch_feed
p=argparse.ArgumentParser();p.add_argument('--db',default='data/discovery.sqlite');s=p.add_subparsers(dest='cmd',required=True)
a=s.add_parser('run');a.add_argument('--input',required=True);a.add_argument('--now');a.add_argument('--mode',choices=['fixture','import'],default='fixture')
a=s.add_parser('fetch');a.add_argument('--source',choices=FEEDS,required=True);a.add_argument('--limit',type=int,default=10)
a=s.add_parser('serve');a.add_argument('--port',type=int,default=4332)
s.add_parser('runs')
a=s.add_parser('export-dsh');a.add_argument('--run-id',required=True);a.add_argument('--output',required=True)
a=s.add_parser('import-dsh');a.add_argument('--task',required=True);a.add_argument('--result',required=True)
args=p.parse_args();Path(args.db).parent.mkdir(parents=True,exist_ok=True)
if args.cmd=='serve':
    from .server import serve
    serve(args.db,args.port)
else:
    store=Store(args.db)
    if args.cmd=='export-dsh':
        from .dsh_bridge import export_task
        Path(args.output).write_text(json.dumps(export_task(store,args.run_id),ensure_ascii=False,indent=2))
        print(args.output)
    elif args.cmd=='import-dsh':
        from .dsh_bridge import import_result
        cards=import_result(store,json.loads(Path(args.task).read_text()),json.loads(Path(args.result).read_text()))
        print(json.dumps({'imported':len(cards),'human_review':'pending'}))
    elif args.cmd=='runs':print(json.dumps(store.runs(),ensure_ascii=False,indent=2))
    else:
        started=time.monotonic()
        try:
            docs=fetch_feed(args.source,args.limit) if args.cmd=='fetch' else json.loads(Path(args.input).read_text())
        except Exception as exc:
            if args.cmd!='fetch':raise
            rid=store.new_run('live',utcnow())
            store.transition(rid,'collect',dict(status='failed',unit='request',input_count=1,output_count=0,completed_count=0,failed_count=1,skipped_count=0,pending_count=0,retries=0,duration_ms=round((time.monotonic()-started)*1000),quality=[],items=[dict(item_id=args.source,status='failed',reason=type(exc).__name__)],request_count=1),'module.failed')
            store.finish(rid,'failed')
            print(json.dumps({'run_id':rid,'error':type(exc).__name__}));sys.exit(1)
        result=run_pipeline(store,docs,now=getattr(args,'now',None),mode='live' if args.cmd=='fetch' else args.mode,collection_stats={'request_count':1,'request_success_count':1,'duration_ms':round((time.monotonic()-started)*1000)} if args.cmd=='fetch' else None)
        print(json.dumps({'run_id':result['run_id'],'candidates':len(result['candidates']),'mode':'live' if args.cmd=='fetch' else args.mode},ensure_ascii=False))
