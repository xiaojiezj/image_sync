# image_sync

把 ZenMux 的 OpenAI 兼容生图接口（`POST https://zenmux.ai/api/v1/images/generations`）包装成**异步任务**服务：

1. 客户端发来生图请求（参数、headers 原样透传给 ZenMux）；
2. 服务**立刻返回一个 `image_id`**；
3. 后台去调用 ZenMux 生图；
4. 之后用这个 `image_id` 查询结果。

只暴露两个接口。零依赖，只用 Node 内置模块（需 Node >= 20，依赖内置 `fetch`）。

## 快速开始

```bash
npm start          # 生产启动
npm run dev        # 热重载
npm test           # 运行测试（用内存 mock 上游，不消耗额度）
```

默认监听 `http://0.0.0.0:3000`。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `3000` | 监听端口 |
| `ZENMUX_BASE_URL` | `https://zenmux.ai/api/v1` | 上游 OpenAI 兼容 base url |
| `ZENMUX_API_KEY` | 空 | 兜底 key；**请求带了 `Authorization` 时以请求为准** |
| `DATA_DIR` | `./data` | 任务存储目录 |
| `UPSTREAM_TIMEOUT_MS` | `900000`（15 分钟） | 单次上游调用超时 |
| `MAX_BODY_BYTES` | `33554432`（32MB） | 请求体大小上限 |
| `FORCE_NON_STREAM` | `true` | 异步模式下强制上游非流式（会移除 body 里的 `stream`） |

参考 `.env.example`。

## API

所有路径同时兼容 `/v1/...` 和 `/api/v1/...` 前缀。

### 1. 提交生图任务

```http
POST /v1/images/generations
Authorization: Bearer $ZENMUX_API_KEY
Content-Type: application/json
```

请求体即 [ZenMux 生图文档](https://zenmux.ai/docs/api/openai/generate-an-image.html) 的参数，原样透传：

```json
{
  "model": "gpt-image-2",
  "prompt": "A cute baby sea otter",
  "n": 1,
  "size": "1024x1024"
}
```

`prompt` 为必填，其余参数（`model` / `n` / `size` / `quality` / `background` / `output_format` / …）按文档透传。

响应 `202 Accepted`：

```json
{
  "image_id": "img_1f74a8e65bd54c39a79e092e8c3e38d3",
  "object": "image.generation",
  "status": "pending",
  "created_at": 1713833628000,
  "query_url": "/v1/images/generations/img_1f74a8e65bd54c39a79e092e8c3e38d3"
}
```

### 2. 查询状态/结果

```http
GET /v1/images/generations/{image_id}
```

返回任务对象，`status` 取值 `pending` / `processing` / `succeeded` / `failed`：

```json
{
  "image_id": "img_1f74a8e65bd54c39a79e092e8c3e38d3",
  "object": "image.generation",
  "status": "succeeded",
  "model": "gpt-image-2",
  "created_at": 1713833628000,
  "updated_at": 1713833645123,
  "request": { "model": "gpt-image-2", "prompt": "A cute baby sea otter", "n": 1, "size": "1024x1024" },
  "response": {
    "created": 1713833628,
    "output_format": "png",
    "data": [{ "b64_json": "..." }]
  },
  "error": null
}
```

- `?raw=1` → 只返回上游原始响应对象（`response` 字段的内容）。

失败时：

```json
{
  "status": "failed",
  "error": {
    "message": "…",
    "type": "ZenmuxError",
    "upstream_status": 400,
    "upstream_body": { "error": { "message": "…" } }
  }
}
```

## curl 示例

```bash
BASE=http://localhost:3000
KEY=$ZENMUX_API_KEY

# 1) 提交
curl -s -X POST $BASE/v1/images/generations \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"A cute baby sea otter","n":1,"size":"1024x1024"}'

# => { "image_id": "img_...", ... }

# 2) 查询
ID=img_xxx
curl -s $BASE/v1/images/generations/$ID

# 取出 base64 图片
curl -s "$BASE/v1/images/generations/$ID" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s);
    if(t.response) require("fs").writeFileSync("output.png", Buffer.from(t.response.data[0].b64_json,"base64"));
  });'
```

## 工作方式与注意事项

- **透传**：请求体与请求头（除 `host` / `content-length` / `transfer-encoding` 等逐跳头）原样转发；`Authorization` 以请求自带的为准，其次才用 `ZENMUX_API_KEY`。`Content-Type` 固定为 `application/json`。
- **异步**：提交接口不等待生图完成，后台调用完成后写入结果。因此上游耗时很长也不会占用客户端连接。
- **持久化**：任务写在 `DATA_DIR/tasks/<image_id>.json`（含完整上游响应，即 base64 图片）。重启后已完成的任务仍在；重启时处于 `pending`/`processing` 的任务会被标记为 `failed`（原因 `server_restart`，上游无法续跑）。
- **流式**：为了异步语义，默认移除 `stream` 参数强制非流式；如需保留可设 `FORCE_NON_STREAM=false`（此时响应会以 `response.raw` 形式保存 SSE 文本，不建议）。

## 目录结构

```
src/
  index.js    启动入口 & 优雅退出
  app.js      HTTP 路由 / 异步任务调度
  store.js    文件型任务存储
  zenmux.js   上游调用封装
  config.js   环境变量配置
test/
  smoke.test.js  端到端冒烟测试（mock 上游）
```
