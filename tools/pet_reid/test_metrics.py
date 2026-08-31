import unittest

from evaluate_dataset import auc_from_scores, threshold_metrics


class MetricTests(unittest.TestCase):
    def test_auc_is_one_for_perfect_separation(self):
        self.assertEqual(auc_from_scores([0.8, 0.9], [0.1, 0.2]), 1.0)

    def test_auc_handles_ties(self):
        self.assertEqual(auc_from_scores([0.5], [0.5]), 0.5)

    def test_target_far_operating_point(self):
        metrics = threshold_metrics([0.8, 0.9], [0.1, 0.2], target_far=0.0)
        self.assertEqual(metrics["far_at_operating_threshold"], 0.0)
        self.assertEqual(metrics["tar_at_operating_threshold"], 1.0)


if __name__ == "__main__":
    unittest.main()
