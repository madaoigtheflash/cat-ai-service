FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    REID_ENGINE=onnx \
    REID_MODEL_PATH=/models/pet-recognition-small.onnx \
    REID_MAX_REQUEST_BYTES=16777216

RUN apt-get update \
    && apt-get install --no-install-recommends -y libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /service
COPY services/reid-service/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/reid-service/app ./app
COPY tools/pet_reid/models/pet-recognition-small.onnx /models/pet-recognition-small.onnx

RUN useradd --create-home --uid 10001 worker \
    && chown -R worker:worker /service /models
USER worker

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/internal/v1/ready', timeout=2)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
