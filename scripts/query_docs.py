#!/usr/bin/env python3
"""
RAG Query Engine for Lumina Edge
Retrieves relevant document chunks and queries the local LLM
"""

import os
import json
import sys
import requests
from sentence_transformers import SentenceTransformer
import chromadb

def load_config(config_path: str = "config.json") -> dict:
    with open(config_path, 'r', encoding='utf-8') as f:
        return json.load(f)

def load_system_prompt(preset_path: str) -> str:
    """Load system prompt from preset file"""
    with open(preset_path, 'r', encoding='utf-8') as f:
        return f.read().strip()

def retrieve_relevant_chunks(query: str, config: dict, top_k: int = 5) -> dict:
    """
    Retrieve most relevant document chunks for the query
    """
    # Initialize embedding model
    embedding_model = SentenceTransformer(config['embedding_model'])

    # Initialize ChromaDB
    client = chromadb.PersistentClient(path=config['vectordb_path'])
    collection_name = f"{config['use_case']}_docs"

    try:
        collection = client.get_collection(name=collection_name)
    except Exception:
        print(f"Error: Collection '{collection_name}' not found. Run ingest_docs.py first.")
        sys.exit(1)

    # Embed query
    query_embedding = embedding_model.encode([query])[0].tolist()

    # Search
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=top_k
    )

    return results

def query_llm(system_prompt: str, user_query: str, context: str, config: dict) -> str:
    """
    Send query to Lumina Edge API with retrieved context
    """
    # Simplified prompt for TinyLlama - single user message with system context
    full_prompt = f"""{system_prompt}

DOCUMENT CONTEXT:
{context}

QUESTION: {user_query}

INSTRUCTION: Answer using only the DOCUMENT CONTEXT above. If the answer is not there, say "This information is not in the provided documents."""

    messages = [
        {"role": "user", "content": full_prompt}
    ]

    # Call Lumina Edge API (reads port from config, defaults to 1234)
    api_port = config.get('api_port', 1234)
    api_url = f"http://127.0.0.1:{api_port}/v1/chat/completions"

    payload = {
        "model": config.get('model', 'local'),
        "messages": messages,
        "temperature": config.get('temperature', 0.3),
        "max_tokens": 1000,
        "stream": False
    }

    try:
        response = requests.post(api_url, json=payload, timeout=120)
        response.raise_for_status()
        data = response.json()
        return data['choices'][0]['message']['content']
    except requests.exceptions.ConnectionError:
        return f"Error: Cannot connect to Lumina Edge API at {api_url}. Ensure the server is running (launch via scripts in core/)."
    except Exception as e:
        return f"Error querying LLM: {str(e)}"

def main():
    if len(sys.argv) < 2:
        print('Usage: python query_docs.py "Your question here"')
        print('Example: python query_docs.py "What is our vacation policy?"')
        sys.exit(1)

    user_query = " ".join(sys.argv[1:])
    config = load_config()

    if not config.get('rag_enabled', False):
        print("Error: RAG is disabled in config.json")
        sys.exit(1)

    # Load system prompt
    system_prompt = load_system_prompt(config['system_prompt_preset'])

    # Retrieve relevant chunks
    print(f'Retrieving relevant context for: "{user_query}"\n')
    results = retrieve_relevant_chunks(user_query, config, top_k=config['retrieval_top_k'])

    if not results['documents'][0]:
        print("No relevant documents found. Ensure documents have been ingested.")
        sys.exit(1)

    # Format context
    context_parts = []
    for i, (doc, metadata) in enumerate(zip(results['documents'][0], results['metadatas'][0])):
        source = metadata['source']
        context_parts.append(f"[Source: {source}]\n{doc}\n")

    context = "\n---\n".join(context_parts)

    print("Context retrieved. Querying LLM...\n")

    # Query LLM
    answer = query_llm(system_prompt, user_query, context, config)

    print("=" * 60)
    print("ANSWER:")
    print("=" * 60)
    print(answer)
    print("\n" + "=" * 60)
    print("\nSources:")
    for metadata in results['metadatas'][0]:
        print(f"  - {metadata['source']}")

if __name__ == "__main__":
    main()
