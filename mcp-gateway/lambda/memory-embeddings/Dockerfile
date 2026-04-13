# sentence-transformers embedding Lambda
# Uses AWS base image for Python Lambda
FROM public.ecr.aws/lambda/python:3.13

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install --no-cache-dir -r ${LAMBDA_TASK_ROOT}/requirements.txt

# Pre-download the model during build so cold starts don't fetch from HuggingFace
ARG MODEL_NAME=all-MiniLM-L6-v2
ENV MODEL_NAME=${MODEL_NAME}
ENV SENTENCE_TRANSFORMERS_HOME=/var/task/models
ENV TRANSFORMERS_CACHE=/var/task/models
ENV HF_HOME=/var/task/models

RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${MODEL_NAME}')"

COPY handler.py ${LAMBDA_TASK_ROOT}/

CMD ["handler.lambda_handler"]
