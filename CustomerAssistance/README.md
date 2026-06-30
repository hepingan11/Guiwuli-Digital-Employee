# 客服辅助 AI 插件 MVP

这是一个可本地运行的 MVP：Chrome 插件从网页 DOM 捕捉聊天消息，发送到 FastAPI；后端入库后由 Celery 基于 PostgreSQL + pgvector 做 RAG，生成客服回复建议。插件只展示建议，不会自动发送消息。

## 启动后端

```bash
copy .env.example .env
docker compose up --build
```

API 默认在 `http://localhost:8000`，默认 API Key 是 `dev-api-key`。API 容器启动时会自动执行 `alembic upgrade head`，初始化数据库、启用 `vector` 扩展并插入 Demo Organization。

健康检查：

```bash
curl http://localhost:8000/health
```

## 加载 Chrome 插件

1. 打开 `chrome://extensions`
2. 开启“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择本项目的 `extension/` 目录

popup 中先配置后端地址、API Key 和 selector，再打开“启用捕捉”。插件是客服辅助工具，只展示 AI 建议，由客服手动复制或采纳。

## Selector 配置

需要按目标网页填写：

- 聊天消息容器 selector：例如 `.chat-list`
- 单条消息 selector：例如 `.message`
- 消息文本 selector：例如 `.message-text`
- 发送人 selector：可选，例如 `.sender`
- 时间 selector：可选，例如 `.time`

插件会监听消息容器内 DOM 新增节点，并用 `sender + time + content` 做去重。发送人或 class 中包含 `customer/client/user/客户` 会识别为客户消息，包含 `agent/service/客服` 会识别为客服消息，否则为 `unknown`。只有客户消息会触发 AI 建议任务。

popup 提供“自动定位并填入”和“AI 检查 selector”。前者会在当前页面本地根据一段真实消息文本推断 selector；后者会把当前 selector、匹配统计、少量 DOM 摘要和提取预览发送到后端 `/api/selector-review`，由 LLM 或 mock 规则检查 selector 是否过窄、是否匹配为空、是否适合持续捕捉。不会上传 cookie、token 或密码。

## 上传知识库

MVP 支持 `.txt` 和 `.md`：

```bash
curl -X POST http://localhost:8000/api/knowledge/documents \
  -H "X-API-Key: dev-api-key" \
  -F "file=@samples/knowledge.md"
```

查看文档：

```bash
curl -H "X-API-Key: dev-api-key" \
  http://localhost:8000/api/knowledge/documents
```

重新索引：

```bash
curl -X POST -H "X-API-Key: dev-api-key" \
  http://localhost:8000/api/knowledge/documents/1/reindex
```

没有 `OPENAI_API_KEY` 时会使用 mock embedding 和 mock LLM，链路仍能跑通；配置 key 后会调用 OpenAI provider。如需使用 OpenAI 兼容接口，可设置 `OPENAI_BASE_URL`。

## API 测试完整流程

创建或获取会话：

```bash
curl -X POST http://localhost:8000/api/conversations \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-api-key" \
  -d "{\"external_id\":\"demo-chat-1\",\"page_url\":\"https://example.com/chat\",\"title\":\"Demo Chat\"}"
```

发送客户消息：

```bash
curl -X POST http://localhost:8000/api/messages \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-api-key" \
  -d "{\"conversation_id\":1,\"sender_type\":\"customer\",\"sender_name\":\"张三\",\"content\":\"我的订单什么时候发货？\",\"source_message_id\":\"msg-001\",\"raw_payload\":{\"page_url\":\"https://example.com/chat\"}}"
```

稍等 Celery 生成建议后查询：

```bash
curl -H "X-API-Key: dev-api-key" \
  http://localhost:8000/api/conversations/1/suggestion
```

## 项目结构

```text
backend/
  app/
    main.py
    core/
    models/
    schemas/
    api/
    services/
    workers/
  alembic/
  requirements.txt
  Dockerfile
extension/
  manifest.json
  src/
docker-compose.yml
.env.example
README.md
```

## 安全说明

- 所有业务接口使用 `X-API-Key` 简单鉴权。
- 插件必须手动启用才捕捉消息。
- 插件和后端都会避免保存 `cookie/token/password/authorization/secret` 等敏感字段。
- 插件不会自动发送消息，只提供复制建议。
