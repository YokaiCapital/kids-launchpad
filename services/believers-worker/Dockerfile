FROM python:3.12-slim
WORKDIR /app
RUN pip install --no-cache-dir certifi==2025.8.3 requests==2.32.4
COPY xapi.py worker.py classify.py base58_oncurve.py ./
COPY seed /app/seed
ENV WORK_DIR=/data
VOLUME ["/data"]
# First run on an empty volume starts from the seed (1,029 supporters with their original since dates); later runs keep the volume's state.
CMD ["sh","-c","mkdir -p \"$WORK_DIR\" && for f in supporters.json state.json supporter-wallets.json; do [ -e \"$WORK_DIR/$f\" ] || cp \"/app/seed/$f\" \"$WORK_DIR/$f\"; done && exec python3 worker.py"]
