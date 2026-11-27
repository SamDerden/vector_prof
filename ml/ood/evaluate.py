"""Offline baseline; never changes the runtime OOD filter or calls an external API."""
import json
import platform
import time
from pathlib import Path
import numpy as np
import sklearn
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.metrics import classification_report, confusion_matrix

HERE=Path(__file__).resolve().parent
LABELS=['relevant','out_of_domain','needs_clarification']

def evaluate():
    rows=[json.loads(line) for line in (HERE/'pilot.jsonl').read_text().splitlines()]
    seen={}
    for r in rows: seen.setdefault(r['intent_group'],set()).add(r['split'])
    assert all(len(v)==1 for v in seen.values()), 'intent leakage'
    normalized={}
    for r in rows:
        key=' '.join(r['question'].casefold().split())
        assert key not in normalized, 'duplicate text'
        normalized[key]=r['split']
    train=[r for r in rows if r['split']=='train']
    model=make_pipeline(TfidfVectorizer(analyzer='char_wb',ngram_range=(3,5),sublinear_tf=True),
                        LogisticRegression(class_weight='balanced',max_iter=1000,random_state=27))
    started=time.perf_counter()
    model.fit([r['question'] for r in train],[r['label'] for r in train])
    report={'python':platform.python_version(),'sklearn':sklearn.__version__,
            'training_seconds':time.perf_counter()-started,'model':'char TF-IDF (3,5) + balanced LogisticRegression',
            'runtime_enabled':False,'human_reviewed':0,
            'limitation':'Synthetic engineering baseline; cannot estimate quality on schoolchildren. Question-only baseline ignores conversation context.'}
    challenge=json.loads((HERE/'challenge.json').read_text())
    for name,data in [('validation',[r for r in rows if r['split']=='validation']),('test',[r for r in rows if r['split']=='test']),('challenge',challenge)]:
        truth=[r['label'] for r in data];pred=model.predict([r['question'] for r in data]).tolist()
        times=[]
        for r in data:
            t=time.perf_counter();model.predict([r['question']]);times.append((time.perf_counter()-t)*1000)
        positives=sum(y=='relevant' for y in truth)
        report[name]={'rows':len(data),'metrics':classification_report(truth,pred,labels=LABELS,output_dict=True,zero_division=0),
            'labels':LABELS,'confusion_matrix':confusion_matrix(truth,pred,labels=LABELS).tolist(),
            'relevant_false_rejection':sum(y=='relevant' and p=='out_of_domain' for y,p in zip(truth,pred))/positives if positives else None,
            'relevant_not_recognized':sum(y=='relevant' and p!='relevant' for y,p in zip(truth,pred))/positives if positives else None,
            'latency_ms_p50':float(np.percentile(times,50)),'latency_ms_p95':float(np.percentile(times,95)),
            'errors':[{'question':r['question'],'expected':y,'predicted':p} for r,y,p in zip(data,truth,pred) if y!=p]}
    (HERE/'baseline-report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    for name in ['validation','test','challenge']:
        print(name,'macro-F1',round(report[name]['metrics']['macro avg']['f1-score'],3),'missed relevant',report[name]['relevant_not_recognized'])
if __name__=='__main__': evaluate()
