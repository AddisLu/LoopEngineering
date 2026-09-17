# SearXNG（對話頁「上網／工具」的搜尋後端）

```bash
cd deploy/searxng
# secret_key 已在 settings.yml；換一把：sed -i "s/secret_key: .*/secret_key: \"$(openssl rand -hex 32)\"/" settings.yml
docker compose up -d
curl -s 'http://127.0.0.1:8080/search?q=vllm&format=json' | head -c 300
```

只綁 127.0.0.1:8080；Loop 以 `chat_search_url`（預設 `http://127.0.0.1:8080`）找到它。
查詢不經第三方 API，SearXNG 會直接向 Google／Bing／DuckDuckGo 等引擎送出請求。
