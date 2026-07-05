<div align="center">

# NooMiChat

**基于 Cloudflare Workers 的 Telegram 双向私聊 bot**

NooMiChat 是基于 RelayGo 开源项目二次开发的 Telegram 双向私聊 bot。  
用户私聊 Bot，消息转发给管理员；绑定群组后，每个用户自动进入独立 Topic，管理员在 Topic 内直接回复。

[项目地址：lijboys/NooMiChat](https://github.com/lijboys/NooMiChat)

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![D1](https://img.shields.io/badge/Database-D1-orange)](https://developers.cloudflare.com/d1/)
[![KV](https://img.shields.io/badge/Storage-KV-blue)](https://developers.cloudflare.com/kv/)
[![Workers AI](https://img.shields.io/badge/AI-Workers%20AI-purple)](https://developers.cloudflare.com/workers-ai/)
[![Version](https://img.shields.io/badge/version-2.1.8-blueviolet)](#)

</div>

---

## ✨ 功能

- 🚀 **纯 Worker 部署**：单文件 `RelayGo.js`，无需服务器、无需 Docker。
- 💬 **双向私聊**：用户私聊 Bot，管理员私聊或群 Topic 内回复。
- 🧵 **Topic 模式**：绑定 Telegram 群组后，每个用户一个独立 Topic。
- 🧩 **无群可用**：不绑定群组也能把用户消息转发给主人私聊。
- 🧭 **网页后台**：`/admin` 管理配置、Webhook、验证、黑名单、协管。
- 🔐 **验证系统**：Turnstile、reCAPTCHA、本地问答、贴纸/表情、图片数字。
- 🚫 **黑名单与申诉**：本地黑名单、重新验证、本地申诉入口。
- 👮 **协管权限**：`reply`、`panel`、`ban`、`config`。
- 🌐 **AI 翻译**：非中文消息追加中文翻译，失败不影响中继。
- 📦 **导入导出**：只导出业务配置，不导出 Token 和环境变量。

## 🚀 快速部署

### 1. 创建 Telegram Bot

1. 找 `@BotFather` 发送 `/newbot`。
2. 保存机器人 Token，后面填入 `BOT_TOKEN`。
3. 找 `@userinfobot` 获取你的 Telegram 数字 ID，后面填入 `OWNER_ID`。

> `OWNER_ID` 是你自己的 Telegram 数字 ID，不是用户名、手机号或 Bot ID。

### 2. 创建 Worker

1. 打开 Cloudflare Dashboard。
2. 进入 `Workers & Pages`。
3. 创建 Worker，进入 `Edit code`。
4. 删除默认代码，粘贴 `RelayGo.js` 全部内容。
5. 点击 `Deploy`。

### 3. 添加环境变量

进入 Worker：`Settings` → `Variables and Secrets`。

| 变量名 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `BOT_TOKEN` | ✅ | Secret | BotFather 给你的 Bot Token |
| `OWNER_ID` | ✅ | Variable | 你的 Telegram 数字 ID |
| `ADMIN_KEY` | ✅ 推荐 | Secret | 网页后台登录密码 |

### 4. 添加绑定

进入 Worker：`Settings` → `Bindings`。

| 类型 | 变量名 | 说明 |
| --- | --- | --- |
| KV Namespace | `KV` | 必须叫 `KV` |
| D1 database | `DB` | 推荐叫 `DB`，也兼容 `D1`、`DATABASE`、`NOOMICHAT_DB`、`RELAYGO_DB` |
| Workers AI | `AI` | 可选，用于 AI 翻译 |

> 注意：`KV` 必须是 KV Namespace 绑定，不要在 Variables 里手动创建普通变量 `KV`。

### 5. 打开后台设置 Webhook

部署后打开：

```text
https://你的Worker域名/admin
```

输入 `ADMIN_KEY`，点击：

```text
设置 Webhook + 菜单
```

登录成功后，后台密码会在当前浏览器缓存 30 天。

## 🧵 绑定群组

完整 Topic 模式需要 Telegram 群组开启 `Topics / 话题`。

1. 把 Bot 拉进群。
2. 给 Bot 管理员权限，建议开启：
   - 管理话题
   - 发送消息
   - 删除消息
   - 置顶消息
3. 在群里发送：

```text
/bind
```

多个 Bot 共用同一个群时，建议指定 Bot：

```text
/bind@你的Bot用户名
```

绑定后：

- 用户私聊 Bot，会自动创建个人 Topic。
- 管理员在该 Topic 内回复，消息会发回用户私聊。
- Topic 名称和顶部资料卡用于识别用户。

## 🧭 管理入口

| 入口 | 用途 |
| --- | --- |
| `/admin` | 网页后台 |
| `/menu` / `/panel` | Telegram 内联管理面板 |
| `/bind` | 绑定当前群组 |
| `/admins` | 查看协管 |
| `/addadmin` | 添加协管 |
| `/deladmin` | 删除协管 |
| `/export` | 导出业务配置 |
| `/import` | 导入业务配置 |

### 后台目录

| 目录 | 内容 |
| --- | --- |
| **部署** | Worker 状态、Webhook、Bot 命令菜单、诊断 |
| **运营** | 营业状态、休息提示、AI 翻译 |
| **安全** | 验证、防骚扰、关键词、联合封禁 |
| **内容** | 欢迎语、自动回复、品牌文案、欢迎按钮 |
| **用户** | 本地黑名单、本地申诉、联合申诉、协管 |

## 🔑 权限

`OWNER_ID` 默认全权限。协管保存在 D1。

| 权限 | 能力 |
| --- | --- |
| `reply` | 回复用户、设置备注和标签 |
| `panel` | 查看后台和协管列表 |
| `ban` | 封禁 / 解封用户 |
| `config` | 修改配置、导入导出、绑定群组 |

添加协管：

```text
/addadmin 123456789 reply,panel
```

添加全权限协管：

```text
/addadmin 123456789 reply,panel,ban,config
```

## 🤖 AI 翻译

绑定 Workers AI 后，在后台开启 `AI 翻译` 即可。

默认翻译模型：

```text
@cf/meta/m2m100-1.2b
```

显示规则：

- **无群模式**：翻译卡片显示发送人、UID、用户名、原文和译文，回复翻译卡片也会发回对应用户。
- **群 Topic 模式**：翻译卡片只显示原文和译文，身份由 Topic 名称和顶部资料卡承担。

## 📦 导入导出

导出：

```text
/export
```

导入：

```text
/import
{
  "config": {
    "business_status": "open"
  }
}
```

不会导入 / 导出：

- `BOT_TOKEN`
- `OWNER_ID`
- `ADMIN_KEY`
- D1 / KV 绑定名
- Worker 环境变量
- 任意包含 `token` 或 `secret` 的配置键

## ✅ 部署检查

- [ ] Worker 根路径返回 `running`。
- [ ] `bindings.bot_token=true`。
- [ ] `bindings.owner_id=true`。
- [ ] `bindings.kv=true`。
- [ ] `bindings.d1=true`。
- [ ] `/admin` 可以登录。
- [ ] 点击 `设置 Webhook + 菜单` 成功。
- [ ] 私聊 Bot 发送 `/start` 有回复。
- [ ] 如果使用群 Topic，群里发送 `/bind` 或 `/bind@你的Bot用户名` 成功。

## ❓ FAQ

### Q：D1 数据库需要初始化吗？

A：不需要。只要 D1 绑定成功，首次访问或收到 Webhook 后会自动执行 `CREATE TABLE IF NOT EXISTS` 初始化表结构。

自动创建：

```text
config
users
topics
admins
verify_sessions
blacklist
inbox_cards
profile_cards
audit_logs
```

### Q：KV 还需要吗？

A：需要。KV 用于验证会话、冷却、临时缓存、Topic 映射兼容等状态。变量名必须叫 `KV`，并且必须是 KV Namespace 绑定。

### Q：D1 会存用户消息正文吗？

A：不会主动保存用户消息正文。D1 主要保存用户资料、状态、Topic 映射、配置、黑名单、卡片 message_id 和审计日志。消息正文由 Telegram 自身保存。

### Q：不创建群组可以用吗？

A：可以。未绑定群组时，用户私聊会转发给主人私聊；但 CRM 资料卡、聚合收件箱、黑名单 Topic 等完整能力需要群组 Topic。

### Q：一个群里能放多个这种 Bot 吗？

A：可以。建议使用 `/bind@Bot用户名` 精确绑定，避免多个 Bot 抢命令。每个 Bot 使用自己的 D1/KV 映射，同一个用户私聊不同 Bot 默认会进入不同 Topic。

### Q：Webhook 已经设置但 Bot 没反应怎么办？

A：打开 Worker 根路径，看 `status` 和 `problems`；再进入 `/admin` 点击诊断。`Webhook is already set` 只说明 Telegram 保存了 URL，不代表 Worker 正常处理消息。

### Q：提示 `env.KV.get is not a function` 怎么办？

A：说明 `KV` 不是 KV Namespace 绑定，通常是把 `KV` 错加成了普通变量或 Secret。删除错误变量，到 `Bindings` 添加 KV Namespace，变量名填 `KV`，然后重新部署。

### Q：后台密码是什么？

A：优先使用环境变量 `ADMIN_KEY`。如果没设置，临时使用 `OWNER_ID`。正式使用建议设置强密码 `ADMIN_KEY`。

### Q：OWNER_ID 填什么？

A：填你自己的 Telegram 数字 ID。可以通过 `@userinfobot` 查询。

### Q：用户没验证前发的消息会保存吗？

A：不会。未通过验证的消息会丢弃，不转发、不缓存、不创建 Topic。验证通过后需要用户重新发送。

### Q：AI 翻译不显示怎么办？

A：检查 Workers AI 绑定名是否为 `AI`，后台是否开启 AI 翻译，用户消息是否本身已经是中文。

### Q：如何升级？

A：备份当前 `RelayGo.js`，导出业务配置 JSON，在测试 Worker 验证后再替换生产代码。不要提交真实 Token、Secret 或环境变量。

## 📄 文件结构

```text
.
├── RelayGo.js   # Worker 主程序
└── README.md    # 部署和使用文档
```

---

<div align="center">

**NooMiChat — 基于 RelayGo 二次开发，用 Cloudflare Workers 搭建轻量、可控、免服务器的 Telegram双向私聊bot。**

</div>
