process.env.DB_DATABASE = 'gmind_test';
process.env.REDIS_URL = 'redis://127.0.0.1:63790/1';
// 图片存储走 e2e 专用目录（storage.e2e-spec.ts 的 afterAll 会清理），不污染默认 ./.data/storage
process.env.STORAGE_DIR = './.data/storage-e2e';
// 协同网关落库防抖压低（默认 2000/10000），加速 doc_state 回写与 persisted ack 断言
process.env.COLLAB_DEBOUNCE_MS = '300';
process.env.COLLAB_MAX_DEBOUNCE_MS = '1500';
