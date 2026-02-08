# ws-ssh-proxy 0.2.0

## 機能

- REST で SSH 接続を管理（作成/一覧/削除/リサイズ）
- WebSocket で既存接続にアタッチして SSH shell (PTY) を中継（同時接続可）
- SSE で connections 更新の **最小サマリ**を通知し、クライアントは通知をトリガに GET snapshot を取得（ポーリング不要）
- `/` でデモUI（xterm.js）を配信
- `/openapi.yaml` で OpenAPI をダウンロード

## 起動

```bash
npm i
npm run build
BASE_PATH=/v1/ssh PORT=8080 npm start
```

- Demo: `GET /`
- OpenAPI: `GET /openapi.yaml`

## SSE

- `GET {BASE_PATH}/connections/stream`
- event: `connections`
- data: summary (version/ts/reason/changedIds?/counts)

## Snapshot

- `GET {BASE_PATH}/connections`
- data: full snapshot with version

## 注意

本番では認証/認可・TLS・接続先制限などを追加してください。
