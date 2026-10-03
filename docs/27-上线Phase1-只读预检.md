# 27 · 生产上线 Phase 1（只读预检）记录 — 结论 NO-GO

日期：2026-10-03
范围：**只读**。未写生产库、未部署、未改 nginx/systemd、未改任何 feature branch。
两个合并提交：law-tech `f95854a`（merge PR #3，含 `5ac31c2` 修复）、PKU_Course `1de8ceb`（merge PR #15，含 `4704da0` 修复）—— 都已确认是各自分支的祖先 ✓。

---

## 一、已验证（只读）

### 1. Supabase production（经 REST：service_role + publishable key；**未经 SQL**）

| 检查项 | 结果 |
|---|---|
| `profiles` 列集合 | ✅ 13 列齐全：id / clerk_user_id / display_name / role / created_at / updated_at / email / avatar_url / status / permissions / last_seen_at / auth_user_id / notification_email |
| profiles 行数 | 10 行（不是 2 行：另有 8 个 Clerk 时代账号） |
| legacy OWNER | ✅ 恰好 2 条，均 `status=active`、`auth_user_id IS NULL`：`c23644ed…`（email=`star914@foxmail.com`，非北大域）、`69dc54b1…`（email=NULL） |
| 重复 email（大小写归一） | ✅ 无重复 → `idx_profiles_email_lower` 可安全创建 |
| 重复 auth_user_id | ✅ 全部为 NULL，无重复 → `idx_profiles_auth_user_id` 可安全创建 |
| `app_migration_history` | ❌ 不存在 → **生产从未跑过 migration**，首次运行会应用全部 11 条 |
| `signup_invite_reservations` | ❌ 不存在（预期，由新迁移创建） |
| `provider_credentials` / `course_user_materials` / `signup_invites` | ✅ 均 0 行（无历史密文/无邀请码需要迁移） |
| `pku_connections` / `user_resource_limits` | ✅ 表存在 |
| 仍在生产的旧函数 | `consume_signup_invite`、`release_signup_invite`（service_role 可 EXECUTE）；新的 `reserve/commit/release_signup_invite_reservation`、`link_legacy_owner` **尚不存在** → 迁移最后一条会删掉两个旧函数 ✓ 符合预期 |
| anon 的函数权限 | ✅ 空（anon 对任何 RPC 都没有 EXECUTE） |
| anon 读敏感表 | `provider_credentials` / `signup_invites` / `course_user_materials` → **401 无授权** ✓；`notes` / `reminders` / `reminder_events` / `profiles` / `schedule_items` → 200 但 **0 行**（RLS 已生效）✓ → 第一轮的严重项在生产上已不存在 |

### 2. 腾讯云服务器（只读）

- passwordless sudo ✅、cgroup v2 ✅、磁盘 31G 可用（用 35%）✅、内存 1967MB 总量 / 1231MB 可用（control 计划 MemoryMax=900M，偏紧但可行）
- 当前 release：``/course-runtime → `/releases/course/20261002-214930`（只含 site+admin 两条服务记录）
- **没有** `course-control.service`、**没有** ` `/.course-worker/control-env`；nginx 站点配置里**没有** `/_control/` → 与"待部署"预期一致
- OWNER ` `/.course-worker/env` 32 个键（PKU / 百炼 / R2 / 阿里云 / 微信 / Resend…）保持原样，未改动 ✓
- 环境里**没有任何** `COURSE_MEMBER_R2_*`
- `course-cycle.service` 7 小时前以 exit 1 失败（OWNER 侧闭环，与本次部署无关）

### 3. 只读快照（已存本地，不含任何密钥）

`deploy/snapshots-20261003/`：`nginx-course.conf`、`course-site.service`、`course-admin.service`、`course-cycle.timer`、`release-history.txt`、`release-meta.txt`
回滚点：服务器 `deploy/release.sh --rollback`（历史在 ``/releases/course/.history`）；本阶段未对生产做任何写入，故无数据库侧回滚需求。

---

## 二、NO-GO：4 条硬阻塞

### 1. 没有可用的 Supabase SQL 通道

- `.env.local` 的 `DATABASE_URL` 指向直连地址 `db.htbbkcxevcouwehpugwc.supabase.co`，**只有 AAAA（IPv6）**；本机与腾讯云服务器都无 IPv6 路由（`EHOSTUNREACH` / `Network is unreachable`）。
- IPv4 的 Supavisor pooler 中，租户确实在 `aws-1-ap-southeast-1.pooler.supabase.com`（其它区域返回 "tenant not found"），但用该密码 **认证失败**（6543 与 5432 都失败）→ 说明这份密码已被轮换/过期。
- 影响：索引定义、RLS 标志、policy、grants 矩阵、列默认值这些**只能在 SQL 层确认**的项无法复核；Phase 2 的 migration 也无法执行。
- 需要：Dashboard → Connect → **Session pooler** 连接串（或最新数据库密码）。

### 2. MEMBER 专用 R2 凭据不存在

`createControlServer()` 默认 `r2 = createR2(env)`，缺 `COURSE_MEMBER_R2_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY` 时启动即抛 `R2 未配置` → **control 服务起不来**。
不能用 OWNER 的 `R2_*` 顶替（首期设计明确禁止）。
需要：专用 MEMBER 桶 + 受限 token 四个值（我会写进 ` `/.course-worker/control-env`，0600）。

### 3. law-tech 的生产部署目标不明确

- `law-tech.dev` 当前由 Vercel 项目 **curacao-top**（仓库 **Curacao914/my-blog**，NotionNext pages-router 博客 + `pages/desk/*` + `pages/api/schedule/*`）提供。
- 合并后的 App Router 代码（**Curacao914/law-tech** `main@f95854a`）在该域名下**完全不存在**：`POST /api/course/*` → 405、`POST /api/account/migrate-owner*` → 405、`GET /auth/owner-confirm` → 404、`GET /desk/settings` → 404（博客自己的 404 页）；而博客自身路由正常（`POST /api/reminders/run` → 401、`/sign-in` → 博客的 `/zh-CN/sign-in`）。
- 本地 `vercel whoami` → 无凭据；law-tech 仓库没有 `.vercel` 链接 → 无法部署、无法写 Vercel env。
- 需要：明确 law-tech 的生产部署方式与访问凭据（Vercel token 或由你手动部署）。

### 4. 两端都没有 `COURSE_CONTROL_SIGNING_KEY`

服务器没有 `control-env`；Vercel 侧无法确认。HMAC 通道在两端共享同一把 ≥32 字节密钥之前不可能联通。
需要：确认由谁生成/写入（服务器侧我可以生成并写入 0600 文件；Vercel 侧需要你或 token）。

---

## 三、顺带提醒（不阻塞）

1. **哪个 OWNER 能迁移**：`69dc54b1…`（email 为 NULL）可走完整流程；`c23644ed…` 的 `profiles.email` 是 `star914@foxmail.com`（非北大域），新流程会 409。请确认当前登录的 Clerk OWNER 是哪一条。
2. **邮箱占用**：`2501211657@law.pku.edu.cn` 已被一个 active member profile 占用。若你的 Clerk 已验证邮箱是 `@stu.pku.edu.cn`（git 提交里的那个）则不冲突；若是 `@law.pku.edu.cn`，迁移会因"该邮箱已关联其他资料"而 409。
3. `course-cycle.service` 目前失败（exit 1），部署前值得看一眼。
4. 服务器内存偏紧（1967MB 总量），首次 MEMBER 测试时建议盯 `systemd-cgtop`。

---

## 四、边界

本阶段**没有**：写生产数据库、跑 migration、部署、reload nginx/systemd、改 feature branch、输出任何密钥值。
Phase 2/3/4/5 **未执行**（按指令 NO-GO 即停止）。
