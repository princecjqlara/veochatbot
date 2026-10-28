import unittest,math,json
import train_v2 as lab
class SourceSafety(unittest.TestCase):
 def record(self,event=None):
  first=lab.legacy.parse_pht('2026-06-01 00:00:00')
  return dict(id='synthetic',page='Azshinari',first=first,event=first+event*lab.HOUR if event else None,observed=first+1000*lab.HOUR,snapshots=[dict(h=h,i=lab.legacy.UNKNOWN,s='Unknown',b='initial_inquiry',inbound=1,quoted=False,form=False,duration=False,returned=False,price_question=True,last_inbound_h=0) for h in [0,1,6,24,72,168,336]])
 def test_future_payment_does_not_enter_training_at_cutoff(self):
  r=self.record(50);cut=r['first']+25*lab.HOUR;sc=lab.schema([r],cut);x,y,w,n=lab.periods([r],cut,sc)
  self.assertEqual(n,0);self.assertTrue((y==0).all());self.assertTrue((w>0).all());self.assertEqual(max(x[:,11]),lab.np.float32(math.log1p(24)))
 def test_changing_future_outcome_or_features_cannot_change_earlier_training(self):
  a=self.record(50);b=self.record(100);b['snapshots'][-1].update(inbound=999,form=True,b='form_details');cut=a['first']+25*lab.HOUR;sc=lab.schema([a],cut)
  first=lab.periods([a],cut,sc);second=lab.periods([b],cut,sc)
  for x,y in zip(first[:3],second[:3]):lab.np.testing.assert_array_equal(x,y)
 def test_event_contributes_exactly_once_per_at_risk_landmark(self):
  r=self.record(8);cut=r['first']+100*lab.HOUR;sc=lab.schema([r],cut);x,y,w,n=lab.periods([r],cut,sc)
  self.assertEqual(n,3);self.assertAlmostEqual(float((y*w).sum()),3)
 def test_censoring_is_observed_exposure_not_a_known_negative_outcome(self):
  r=self.record();cut=r['first']+2*lab.HOUR;sc=lab.schema([r],cut);x,y,w,n=lab.periods([r],cut,sc)
  self.assertAlmostEqual(float(w.sum()),3);self.assertTrue((y==0).all())
 def test_cumulative_hazards_give_monotone_bounded_probabilities(self):
  rates=[.001]*7;ps=[-math.expm1(-lab.legacy.integrate(rates,24,h)) for h in [168,336,720]]
  self.assertTrue(0<=ps[0]<=ps[1]<=ps[2]<=1);q=lab.timing(rates,24,720);self.assertEqual(q,sorted(q));self.assertGreaterEqual(q[0],0);self.assertLessEqual(q[-1],29)
if __name__=='__main__':unittest.main()
