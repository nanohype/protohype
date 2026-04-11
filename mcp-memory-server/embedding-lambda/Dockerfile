# Multi-stage build for the embedding Lambda container image.
# Final image ~1.2 GB (sentence-transformers + torch CPU-only + model).
#
# Build:
#   docker build -t mcp-embedding-lambda .
#
# Test locally:
#   docker run -p 9000:8080 mcp-embedding-lambda
#   curl -XPOST http://localhost:9000/2015-03-31/functions/function/invocations \
#        -d '{"texts":["hello world"]}'
#
# Push to ECR and use as Lambda container image source.

# ── Stage 1: Download model ─────────────────────────────────────────────────
FROM python:3.11-slim AS model-downloader

RUN pip install --no-cache-dir sentence-transformers==3.0.1

# Download and cache the model to /model
RUN python -c "
from sentence_transformers import SentenceTransformer
model = SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2')
model.save('/model')
print('Model saved to /model')
"

# ── Stage 2: Runtime image ──────────────────────────────────────────────────
FROM public.ecr.aws/lambda/python:3.11

# Install torch CPU-only (smaller than CUDA build)
RUN pip install --no-cache-dir \
    torch==2.3.0 --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir \
    sentence-transformers==3.0.1 \
    numpy==1.26.4

# Copy model from downloader stage
COPY --from=model-downloader /model /opt/ml/model

# Copy handler
COPY handler.py ${LAMBDA_TASK_ROOT}/

# Lambda env
ENV MODEL_PATH=/opt/ml/model
ENV MODEL_NAME=all-MiniLM-L6-v2

CMD ["handler.handler"]
