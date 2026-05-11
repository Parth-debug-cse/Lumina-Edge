#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG_FILE="$PROJECT_ROOT/config.json"
LLAMA_SERVER="$PROJECT_ROOT/bin/llama-server"

check_model_exists() {
    local model_path="$1"
    if [[ "$model_path" != /* ]]; then
        model_path="$PROJECT_ROOT/$model_path"
    fi
    if [[ ! -f "$model_path" ]]; then
        echo "ERROR: Model file not found: $model_path" >&2
        return 1
    fi
    echo "Model found: $model_path"
}

wait_for_health() {
    local port=$1
    local name=$2
    local max_attempts=30
    local attempt=1

    echo "Waiting for $name to be healthy on port $port..."
    while [[ $attempt -le $max_attempts ]]; do
        if curl -s "http://localhost:$port/health" > /dev/null 2>&1; then
            echo "$name ready on port $port"
            return 0
        fi
        echo "  Attempt $attempt/$max_attempts - not ready yet..."
        sleep 2
        ((attempt++))
    done
    echo "ERROR: $name failed to become healthy after $max_attempts attempts" >&2
    return 1
}

cleanup() {
    echo ""
    echo "Shutting down pipeline..."
    [[ -n "$CLEANER_PID" ]] && kill "$CLEANER_PID" 2>/dev/null
    [[ -n "$CATEGORIZER_PID" ]] && kill "$CATEGORIZER_PID" 2>/dev/null
    [[ -n "$ORCH_PID" ]] && kill "$ORCH_PID" 2>/dev/null
    wait
    echo "All processes stopped."
}

trap cleanup SIGINT SIGTERM

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "ERROR: config.json not found at $CONFIG_FILE" >&2
    exit 1
fi

echo "Loading config from $CONFIG_FILE..."
CLEANER_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['agents']['cleaner']['port'])")
CATEGORIZER_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['agents']['categorizer']['port'])")
CLEANER_MODEL=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['agents']['cleaner']['model_path'])")
CATEGORIZER_MODEL=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['agents']['categorizer']['model_path'])")
ORCHESTRATOR_PORT=$(python3 -c "import json; print(json.load(open('$CONFIG_FILE'))['api']['port'])")

echo "Cleaner model: $CLEANER_MODEL (port $CLEANER_PORT)"
echo "Categorizer model: $CATEGORIZER_MODEL (port $CATEGORIZER_PORT)"

check_model_exists "$CLEANER_MODEL"
check_model_exists "$CATEGORIZER_MODEL"

if [[ ! -x "$LLAMA_SERVER" ]]; then
    echo "ERROR: llama-server not found or not executable: $LLAMA_SERVER" >&2
    exit 1
fi

echo ""
echo "=========================================="
echo "Starting Agent 1 (Cleaner) on port $CLEANER_PORT..."
echo "=========================================="
cd "$PROJECT_ROOT"
$LLAMA_SERVER \
    --model "$CLEANER_MODEL" \
    --port "$CLEANER_PORT" \
    --host 0.0.0.0 \
    --threads 4 \
    --ctx-size 8192 \
    --batch-size 256 \
    > /tmp/lumina_cleaner.log 2>&1 &
CLEANER_PID=$!
echo "Cleaner PID: $CLEANER_PID"

echo ""
echo "=========================================="
echo "Starting Agent 2 (Categorizer) on port $CATEGORIZER_PORT..."
echo "=========================================="
cd "$PROJECT_ROOT"
$LLAMA_SERVER \
    --model "$CATEGORIZER_MODEL" \
    --port "$CATEGORIZER_PORT" \
    --host 0.0.0.0 \
    --threads 4 \
    --ctx-size 8192 \
    --batch-size 256 \
    > /tmp/lumina_categorizer.log 2>&1 &
CATEGORIZER_PID=$!
echo "Categorizer PID: $CATEGORIZER_PID"

echo ""
echo "Waiting for agents to initialize..."

wait_for_health "$CLEANER_PORT" "Agent 1 (Cleaner)"
wait_for_health "$CATEGORIZER_PORT" "Agent 2 (Categorizer)"

echo ""
echo "=========================================="
echo "Starting Orchestrator on port $ORCHESTRATOR_PORT..."
echo "=========================================="
cd "$SCRIPT_DIR"
python3 orchestrator.py &
ORCH_PID=$!
echo "Orchestrator PID: $ORCH_PID"

wait_for_health "$ORCHESTRATOR_PORT" "Orchestrator"

echo ""
echo "=========================================="
echo "PIPELINE READY"
echo "=========================================="
echo "Agent 1 (Cleaner):  http://localhost:$CLEANER_PORT"
echo "Agent 2 (Categorizer): http://localhost:$CATEGORIZER_PORT"
echo "Orchestrator:     http://localhost:$ORCHESTRATOR_PORT"
echo ""
echo "OpenWebUI should connect to: http://localhost:$ORCHESTRATOR_PORT"
echo "Model name: lumina-pipeline"
echo ""
echo "Press Ctrl+C to stop the pipeline."

wait