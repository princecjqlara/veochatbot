import copy
import unittest
from analyze_stage_replay import frozen_snapshot, signal_group


class FrozenStages(unittest.TestCase):
    def source(self):
        return {'id': 'synthetic', 'page': 'Azshinari', 'first': 0,
                'observed': 1000 * 3600000, 'event': 48 * 3600000,
                'snapshots': [{'h': 24, 'b': 'initial_inquiry', 'form': False, 'duration': False},
                              {'h': 72, 'b': 'form_details', 'form': True, 'duration': True}]}

    def row(self):
        return {'first': 0, 'page': 'Azshinari', 'horizon': 168, 'landmark': 24, 'label': 1}

    def test_later_details_cannot_change_original_stage(self):
        a = self.source()
        b = copy.deepcopy(a)
        b['snapshots'][1].update(b='active_conversation', form=False, duration=False)
        self.assertEqual(signal_group(frozen_snapshot(a, self.row())), 'inquiry_or_conversation')
        self.assertEqual(frozen_snapshot(a, self.row()), frozen_snapshot(b, self.row()))

    def test_immature_horizon_is_rejected(self):
        source = self.source()
        source['observed'] = 25 * 3600000
        with self.assertRaises(AssertionError):
            frozen_snapshot(source, self.row())

    def test_no_exact_checkpoint_must_not_use_later_details(self):
        source = self.source()
        source['snapshots'] = source['snapshots'][1:]
        with self.assertRaises(AssertionError):
            frozen_snapshot(source, self.row())

    def test_already_confirmed_contact_is_rejected(self):
        source = self.source()
        source['event'] = 12 * 3600000
        with self.assertRaises(AssertionError):
            frozen_snapshot(source, self.row())

    def test_future_industry_evidence_is_rejected(self):
        source = self.source()
        source['snapshots'][0]['industry_evidence_ms'] = 25 * 3600000
        with self.assertRaises(AssertionError):
            frozen_snapshot(source, self.row())


if __name__ == '__main__':
    unittest.main()
