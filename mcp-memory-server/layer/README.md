# Embedding Strategy — Lambda Layer vs Container Image

## Recommended: Container Image (Default)

The `embedding-lambda/` directory contains a Docker-based Lambda that bakes
`sentence-transformers/all-MiniLM-L6-v2` into the image at build time.

**Pros:**
- No cold-start download — model is part of the image
- Full control over torch/numpy versions
- Handles the ~1.2 GB model + torch dependency cleanly

**Deploy:**
```bash
# Build and push to ECR
aws ecr create-repository --repository-name mcp-embedding-lambda
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1

docker build -t mcp-embedding-lambda ./embedding-lambda
docker tag mcp-embedding-lambda:latest $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/mcp-embedding-lambda:latest
aws ecr get-login-password | docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
docker push $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/mcp-embedding-lambda:latest

# Then in your CDK stack:
EMBEDDING_FUNCTION_ARN=$(aws lambda get-function --function-name mcp-embedding --query Configuration.FunctionArn --output text)
```

---

## Alternative: Lambda Layer (Lighter Model)

For teams that cannot use container images, a Lambda layer with a lighter
embedding approach works for ≤ 512 MB layer budgets.

### Option A: OpenAI / Bedrock API (No Layer Needed)

Replace `embedding-lambda/handler.py` with an API call to:
- Amazon Bedrock `amazon.titan-embed-text-v2` (1024-dim, ~$0.0001/1K tokens)
- OpenAI `text-embedding-3-small` (1536-dim)

```python
import boto3
import json

bedrock = boto3.client('bedrock-runtime')

def handler(event, context):
    texts = event['texts']
    embeddings = []
    for text in texts:
        response = bedrock.invoke_model(
            modelId='amazon.titan-embed-text-v2:0',
            body=json.dumps({"inputText": text, "dimensions": 384})
        )
        result = json.loads(response['body'].read())
        embeddings.append(result['embedding'])
    return {"embeddings": embeddings, "model": "titan-embed-text-v2", "dim": 384}
```

**Trade-off:** Per-call cost vs. fixed container image cost. Use API if embed volume
is low (<100K embeddings/day) or if you want to avoid the 3 GB container image.

### Option B: `onnxruntime` Layer (All-MiniLM quantized)

A quantized ONNX version of `all-MiniLM-L6-v2` is ~40 MB — fits in a Lambda layer.

```bash
pip install optimum onnxruntime sentence-transformers
optimum-cli export onnx --model sentence-transformers/all-MiniLM-L6-v2 ./onnx-model/
zip -r embedding-layer.zip onnx-model/ onnxruntime/
```

Layer size: ~120 MB (within 250 MB unzipped Lambda layer limit).
