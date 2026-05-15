class Matcher:
    """
    Evaluates resume embeddings against a configurable threshold.
    """

    def __init__(self, embedder, threshold=0.65):
        self.embedder = embedder
        self.threshold = threshold

    def evaluate(self, resume_embedding):
        """
        Compute match score and compare against threshold.
        Returns (score: float, shortlisted: bool).
        """
        score = self.embedder.get_match_score(resume_embedding)
        return score, score >= self.threshold
