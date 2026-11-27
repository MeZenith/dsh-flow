/**
 * 飞书文件直发通道：把 `.md` / `.html` / `.txt` 文档直接上传并发送到聊天窗口。
 *
 * 彻底绕开旧 `dsh-im` 只能发纯文本的限制，手机端在飞书里即可直接点开看完整方案或 HTML 预览！
 *
 * @module dsh-flow/remote/feishu/files
 */
import { Readable } from 'node:stream'

const MAX_FEISHU_FILE_BYTES = 20 * 1024 * 1024

/** 清理文件名，避免非法路径字符导致上传 API 报错。 */
export function safeFileName(name) {
  const clean = String(name ?? 'document.md')
    .replace(/[\\/:*?"<>|\r\n]+/g, '_')
    .trim()
  return clean === '' ? 'document.md' : clean.slice(0, 120)
}

/**
 * 上传并发送单个文件给指定 chat_id（或回复某条 message_id）。
 *
 * @param {{
 *   client: any,
 *   chatId: string,
 *   replyToMessageId?: string,
 *   filename: string,
 *   content: Buffer | string,
 * }} input
 * @returns {Promise<{ ok: boolean, fileKey?: string, messageId?: string, reason?: string }>}
 */
export async function sendFeishuFile({ client, chatId, replyToMessageId, filename, content }) {
  if (client === undefined || client === null) {
    return { ok: false, reason: '飞书客户端未连接' }
  }
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8')
  if (buffer.length === 0) return { ok: false, reason: '文件内容为空' }
  if (buffer.length > MAX_FEISHU_FILE_BYTES) {
    return { ok: false, reason: `文件超过飞书上传上限（${(buffer.length / (1024 * 1024)).toFixed(1)} MB > 20 MB）` }
  }

  const fileName = safeFileName(filename)
  try {
    const uploaded = await client.im.v1.file.create({
      data: {
        file_type: 'stream',
        file_name: fileName,
        file: Readable.from(buffer),
      },
    })
    const fileKey = uploaded?.file_key ?? uploaded?.data?.file_key
    if (typeof fileKey !== 'string' || fileKey === '') {
      return { ok: false, reason: `飞书文件上传未返回 file_key（${uploaded?.msg ?? '未知错误'}）` }
    }

    const msgContent = JSON.stringify({ file_key: fileKey })
    let sent
    if (typeof replyToMessageId === 'string' && replyToMessageId !== '') {
      sent = await client.im.v1.message.reply({
        path: { message_id: replyToMessageId },
        data: { msg_type: 'file', content: msgContent },
      })
    } else {
      if (typeof chatId !== 'string' || chatId === '') {
        return { ok: false, reason: '缺少目标 chatId' }
      }
      sent = await client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: msgContent,
        },
      })
    }
    const messageId = sent?.data?.message_id ?? sent?.message_id ?? ''
    if (sent?.code !== undefined && sent.code !== 0) {
      return { ok: false, fileKey, reason: `飞书文件消息发送失败（code=${sent.code} ${sent.msg ?? ''}）` }
    }
    return { ok: true, fileKey, messageId }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** 批量发送文档附件列表。 */
export async function sendFeishuFiles({ client, chatId, replyToMessageId, attachments = [] }) {
  const results = []
  for (const item of Array.isArray(attachments) ? attachments : []) {
    const res = await sendFeishuFile({
      client,
      chatId,
      replyToMessageId,
      filename: item.filename,
      content: item.content,
    })
    results.push({ filename: item.filename, ...res })
  }
  return results
}
