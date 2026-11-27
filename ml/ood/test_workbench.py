import unittest
from unittest.mock import patch
import numpy as np
import workbench as w

class WorkbenchTests(unittest.TestCase):
    def test_split_and_classes(self):
        data=w.rows()
        self.assertEqual(len(data),500)
        self.assertEqual(set(r['label'] for r in data),set(w.LABELS))
    def test_export_reload_predictions(self):
        model=w.load_model();self.assertEqual(model.predict(['А сколько учиться?'])[0],'relevant')
        self.assertEqual(len(model.predict_proba(['привет'])[0]),3)
    def test_invalid_embeddings_rejected(self):
        with patch.object(w,'request',return_value={'data':[{'index':0,'embedding':[0]*2560}]}):
            with self.assertRaises(ValueError): w.embed(('https://example.invalid','secret','llm','emb'),['question'])
    def test_missing_provider_is_explicit(self):
        with patch.dict(w.os.environ,{},clear=True):
            with self.assertRaises(RuntimeError): w.provider_config()
    def test_llm_cannot_invent_label(self):
        with patch.object(w,'request',return_value={'choices':[{'message':{'content':'sure, here is a poem'}}]}):
            with self.assertRaises(ValueError): w.llm(('https://example.invalid','secret','llm','emb'),'write a poem')
    def test_rejection_metric_separates_clarification(self):
        report=w.metrics([{'question':'a','label':'relevant'},{'question':'b','label':'relevant'}],['needs_clarification','out_of_domain'],[1,2])
        self.assertEqual(report['relevant_false_rejection'],0.5)
        self.assertEqual(report['relevant_not_recognized'],1)

if __name__=='__main__': unittest.main()
