import json, sqlite3, uuid
from datetime import datetime, timezone

def utcnow(): return datetime.now(timezone.utc).isoformat()
def uid(): return uuid.uuid4().hex

class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS modules(run_id TEXT,module_id TEXT,data TEXT NOT NULL,PRIMARY KEY(run_id,module_id));
        CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,run_id TEXT,module_id TEXT,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,run_id TEXT,kind TEXT,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        ''')
    def new_run(self, mode, now):
        r = dict(run_id=uid(),status='running',started_at=utcnow(),updated_at=utcnow(),mode=mode,as_of=now,schema_version='1.0',model='none',cost_status='not_applicable')
        with self.db: self.db.execute('INSERT INTO runs VALUES (?,?)',(r['run_id'],json.dumps(r)))
        return r['run_id']
    def finish(self, rid, status='completed'):
        r=self.run(rid)['run']; r.update(status=status,updated_at=utcnow())
        with self.db: self.db.execute('UPDATE runs SET data=? WHERE id=?',(json.dumps(r),rid))
    def transition(self,rid,module,state,event_type='module.completed',event_id=None):
        eid=event_id or uid(); now=utcnow()
        with self.db:
            if self.db.execute('SELECT 1 FROM events WHERE event_id=?',(eid,)).fetchone(): return False
            state=dict(state,module_id=module,updated_at=now)
            if event_type=='module.completed':
                state['completed_snapshot']={k:v for k,v in state.items() if k!='completed_snapshot'}
            event=dict(event_id=eid,schema_version='1.0',run_id=rid,module_id=module,event_type=event_type,occurred_at=now,received_at=now,payload=state,metric_definition_version='1.0')
            row=self.db.execute('SELECT data FROM runs WHERE id=?',(rid,)).fetchone()
            if row:
                run=json.loads(row[0]);run['updated_at']=now
                self.db.execute('UPDATE runs SET data=? WHERE id=?',(json.dumps(run),rid))
            self.db.execute('INSERT OR REPLACE INTO modules VALUES (?,?,?)',(rid,module,json.dumps(state)))
            self.db.execute('INSERT INTO events(event_id,run_id,module_id,data) VALUES (?,?,?,?)',(eid,rid,module,json.dumps(event)))
        return True
    def artifact(self,rid,kind,data,aid=None):
        aid=aid or uid()
        with self.db: self.db.execute('INSERT INTO artifacts VALUES (?,?,?,?)',(aid,rid,kind,json.dumps(data)))
        return aid
    def artifacts(self,kind=None,rid=None):
        q='SELECT * FROM artifacts WHERE 1=1'; args=[]
        if kind:q+=' AND kind=?';args.append(kind)
        if rid:q+=' AND run_id=?';args.append(rid)
        return [dict(artifact_id=r['id'],run_id=r['run_id'],kind=r['kind'],data=json.loads(r['data'])) for r in self.db.execute(q,args)]
    def events(self,rid=None,after=0):
        q='SELECT * FROM events WHERE sequence>?';args=[after]
        if rid:q+=' AND run_id=?';args.append(rid)
        return [dict(json.loads(r['data']),sequence=r['sequence']) for r in self.db.execute(q+' ORDER BY sequence LIMIT 500',args)]
    def runs(self):return [json.loads(r[0]) for r in self.db.execute('SELECT data FROM runs ORDER BY rowid DESC')]
    def run(self,rid):
        r=self.db.execute('SELECT data FROM runs WHERE id=?',(rid,)).fetchone()
        if not r:raise KeyError(rid)
        ev=self.events(rid)
        cursor=self.db.execute('SELECT COALESCE(MAX(sequence),0) FROM events WHERE run_id=?',(rid,)).fetchone()[0]
        return dict(run=json.loads(r[0]),modules=[json.loads(m[0]) for m in self.db.execute('SELECT data FROM modules WHERE run_id=?',(rid,))],events=ev,cursor=cursor)
    def topic(self,tid):
        r=self.db.execute('SELECT data FROM topics WHERE id=?',(tid,)).fetchone()
        return json.loads(r[0]) if r else None
    def save_topic(self,tid,data):
        with self.db:self.db.execute('INSERT OR REPLACE INTO topics VALUES (?,?)',(tid,json.dumps(data)))
