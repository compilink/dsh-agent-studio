import unittest
from topic_discovery.evidence_checks import check_evidence_packet
class EvidenceChecks(unittest.TestCase):
 def test_dates_empty_logs_and_version(self):
  es=[{'artifact_id':'r','data':{'url':'https://example.org/releases/tag/v1-rc','title':'v1','published_at':'2026-11-10T00:00:00Z'}},{'artifact_id':'q','data':{'source':'github_public_issue','updated_at':'2026-11-09T00:00:00Z','text':'### Relevant log output\n```shell\n\n```\n### OS\nWindows'}}]
  self.assertEqual({h['code'] for h in check_evidence_packet(es)},{'release_display_tag_difference','issue_predates_release','no_supplied_logs'})
 def test_not_flag_real_logs(self):
  self.assertEqual(check_evidence_packet([{'artifact_id':'q','data':{'source':'github_public_issue','text':'### Relevant log output\nerror: test'}}]),[])
if __name__=='__main__':unittest.main()
