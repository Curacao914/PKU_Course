-- 允许 provider_credentials 复用一条 owner-scoped 加密记录保存 MCP 长期访问密钥。
-- 生产现状的 CHECK 只允许 ocr / deepseek / dashscope；本迁移只扩大枚举，不改列、不改数据。
alter table public.provider_credentials
  drop constraint if exists provider_credentials_provider_check;

alter table public.provider_credentials
  add constraint provider_credentials_provider_check
  check (provider = any (array['ocr'::text, 'deepseek'::text, 'dashscope'::text, 'mcp'::text]));
