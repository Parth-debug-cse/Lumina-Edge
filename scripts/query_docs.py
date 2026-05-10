#!/usr/bin/env python3
"""
RAG Query Engine for Lumina Edge
Retrieves relevant document chunks and queries the local LLM
"""

import os
import json
import sys
import argparse

def load_config(config_path: str = "config.json") -> dict:
    with open(config_path, 'r') as f:
        return json.load(f)

def load_system_prompt(preset_path: str) -> str:
    """Load system prompt from preset file"""
    try:
        with open(preset_path, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        print(f"Warning: System prompt preset not found: {preset_path}")
        return "You are a helpful assistant. Answer questions based on the provided context."

def retrieve_relevant_chunks(query: str, config: dict, top_k: int = 5, domain: str = "default"):
    """
    Retrieve most relevant document chunks for the query
    """
    from sentence_transformers import SentenceTransformer
    import chromadb
    
    # Initialize embedding model
    embedding_model_name = config.get('embedding_model', 'all-MiniLM-L6-v2')
    embedding_model = SentenceTransformer(embedding_model_name)
    
    # Initialize ChromaDB
    vectordb_path = config.get('vectordb_path', 'vectordb')
    client = chromadb.PersistentClient(path=vectordb_path)
    
    # AUDIT FIX: domain isolation - use domain-specific collection
    collection_name = f"{domain}_docs"
    
    try:
        collection = client.get_collection(name=collection_name)
    except:
        print(f"ERROR: Collection '{collection_name}' not found.")
        print(f"Run: python scripts/ingest_docs.py <document_directory> --domain {domain}")
        sys.exit(1)
    
    # Embed query
    query_embedding = embedding_model.encode([query])[0].tolist()
    
    # Search
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=top_k,
        include=["documents", "metadatas", "distances"]
    )
    
    # AUDIT FIX: filter by similarity threshold
    threshold = config.get('retrieval_threshold', 0.3)
    filtered_docs = []
    filtered_metas = []
    filtered_dists = []
    
    for i, dist in enumerate(results.get('distances', [[]])[0]):
        if dist <= threshold:
            filtered_docs.append(results['documents'][0][i])
            filtered_metas.append(results['metadatas'][0][i])
            filtered_dists.append(dist)
    
    results['documents'] = [filtered_docs]
    results['metadatas'] = [filtered_metas]
    results['distances'] = [filtered_dists]
    
    return results

def query_llm(system_prompt: str, user_query: str, context: str, config: dict) -> str:
    """
    Send query to Lumina Edge API with retrieved context
    """
    import requests
    import tiktoken
    
    # Get API port from config
    api_port = config.get('api_port', 8090)
    api_url = f"http://127.0.0.1:{api_port}/v1/chat/completions"
    
    # Get context size limit
    ctx_size = config.get('ctx_size', 16384)
    # Reserve tokens for system prompt, user question, and response
    max_context_tokens = ctx_size - 500
    
    # AUDIT FIX: truncate context if it exceeds ctx_size
    try:
        encoding = tiktoken.get_encoding("cl100k_base")
        context_tokens = len(encoding.encode(context))
        
        if context_tokens > max_context_tokens:
            # Truncate context to fit
            truncated_tokens = encoding.decode(encoding.encode(context)[:max_context_tokens])
            context = encoding.decode(truncated_tokens)
            print(f"  ⚠️ Context truncated from {context_tokens} to {max_context_tokens} tokens")
    except Exception:
        pass  # Fallback: don't truncate if tiktoken fails
    
    # Construct prompt with context
    full_prompt = (
        "Context from relevant documents:\n\n" +
        context + "\n\n" +
        "---\n\n" +
        "User question: " + user_query + "\n\n" +
        "Answer based on the context provided. If the answer is not in the context, state that clearly."
    )
    
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": full_prompt}
    ]
    
    # Get model name from config
    model_name = config.get('model', 'local-model')
    temperature = config.get('temperature', 0.7)
    
    payload = {
        "model": model_name,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": 1000,
        "stream": False
    }
    
    try:
        response = requests.post(api_url, json=payload, timeout=120)
        response.raise_for_status()
        data = response.json()
        return data['choices'][0]['message']['content']
    except requests.exceptions.ConnectionError:
        return f"ERROR: Cannot connect to Lumina Edge API on port {api_port}.\nEnsure the server is running:\n  Windows: powershell -File core\\launch_api.ps1\n  Linux:   ./core/launch_api.sh"
    except requests.exceptions.Timeout:
        return "ERROR: Request timed out. The model may be taking too long to respond."
    except Exception as e:
        return f"ERROR querying LLM: {str(e)}"

def format_sources(results):
    """Format source documents for display"""
    sources = []
    for metadata in results['metadatas'][0]:
        source = metadata['source']
        chunk_id = metadata['chunk_id']
        total_chunks = metadata['total_chunks']
        sources.append(f"  📄 {source} (chunk {chunk_id + 1}/{total_chunks})")
    
    # Remove duplicates while preserving order
    seen = set()
    unique_sources = []
    for s in sources:
        if s not in seen:
            seen.add(s)
            unique_sources.append(s)
    
    return unique_sources

def main():
    parser = argparse.ArgumentParser(description="Query documents using RAG")
    parser.add_argument("query", nargs="+", help="Your question about the documents")
    parser.add_argument("--top-k", "-k", type=int, default=None, help="Number of chunks to retrieve (default: from config)")
    parser.add_argument("--domain", "-d", choices=["legal", "hr", "ngo"], default="default",
                       help="Domain to query (must match domain used during ingestion)")
    args = parser.parse_args()
    
    user_query = " ".join(args.query)
    config = load_config()
    
    # AUDIT FIX: domain isolation - use domain-specific top_k from config
    domain = args.domain
    domain_top_k = config.get(f'retrieval_top_k_{domain}', config.get('retrieval_top_k', 5))
    top_k = args.top_k if args.top_k else domain_top_k
    
    # Check if RAG is enabled
    if not config.get('rag_enabled', True):
        print("ERROR: RAG is disabled in config.json")
        print("Set 'rag_enabled': true to use this feature.")
        sys.exit(1)
    
    # AUDIT FIX: domain-specific system prompt
    preset_path = config.get(f'system_prompt_preset_{domain}', config.get('system_prompt_preset', 'presets/default.txt'))
    system_prompt = load_system_prompt(preset_path)
    
    # Retrieve relevant chunks
    print(f"🔍 Query: \"{user_query}\"")
    print(f"📚 Retrieving top {top_k} relevant chunks from {domain} collection...\n")
    
    results = retrieve_relevant_chunks(user_query, config, top_k=top_k, domain=domain)
    
    if not results['documents'][0]:
        # AUDIT FIX: clear "no relevant documents" message
        print("❌ No relevant documents found above similarity threshold.")
        print(f"Ensure documents have been ingested for domain '{domain}':")
        print(f"  python scripts\\ingest_docs.py demo_docs\\ --domain {domain}")
        sys.exit(1)
    
    # Format context
    context_parts = []
    for i, (doc, metadata) in enumerate(zip(results['documents'][0], results['metadatas'][0])):
        source = metadata['source']
        chunk_num = metadata['chunk_id'] + 1
        context_parts.append(f"[Source: {source} - Chunk {chunk_num}]\n{doc}\n")
    
    context = "\n---\n".join(context_parts)
    
    # Get API port for display
    api_port = config.get('api_port', 8090)
    print(f"✓ Retrieved {len(results['documents'][0])} chunks")
    print(f"⚙️ Querying LLM on port {api_port}...\n")
    
    # Query LLM
    answer = query_llm(system_prompt, user_query, context, config)
    
    # Display results
    print("=" * 70)
    print("📝 ANSWER:")
    print("=" * 70)
    print(answer)
    print("=" * 70)
    
    # Display sources
    sources = format_sources(results)
    if sources:
        print("\n📚 Sources Referenced:")
        for source in sources:
            print(source)
    
    print()

def check_dependencies():
    """Check if required dependencies are installed"""
    missing = []
    
    try:
        import requests
    except ImportError:
        missing.append("requests")
    
    try:
        import chromadb
    except ImportError:
        missing.append("chromadb")
    
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        missing.append("sentence-transformers")
    
    if missing:
        print("ERROR: Missing required dependencies:")
        for pkg in missing:
            print(f"  - {pkg}")
        print("\nInstall with: pip install " + " ".join(missing))
        sys.exit(1)

if __name__ == "__main__":
    # Check dependencies first
    check_dependencies()
    main()
