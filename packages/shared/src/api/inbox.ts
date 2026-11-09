import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, Uuid } from './primitives.ts';

// The two-way WhatsApp inbox (PRD M11-04, M11 rules; tab 3 message_threads, messages; tab 4
// GET /message-threads; S29; T-115). Free text only within 24 hours of the guest's last
// message; after that, only an approved template can reach them.

export const MESSAGE_DIRECTIONS = ['IN', 'OUT'] as const;
export const INBOX_MESSAGE_STATUSES = [
  'RECEIVED',
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
] as const;

export const ThreadItem = z
  .object({
    id: Uuid,
    phone: z.string(),
    guest: z.object({ id: Uuid, name: z.string() }).nullable(),
    reservation: z.object({ id: Uuid, confirmationNo: z.string(), status: z.string() }).nullable(),
    lastMessageAt: Instant,
    lastPreview: z.string(),
    unreadCount: z.number().int(),
    /** Within 24 hours of the guest's last message: free text can be sent. */
    windowOpen: z.boolean(),
    /** The assistant passed this to a person, or could not answer (T-117). */
    needsStaff: z.boolean(),
    /** Staff have taken over: the assistant stays quiet for now. */
    assistantPaused: z.boolean(),
  })
  .meta({ id: 'MessageThread' });

export const ThreadMessage = z
  .object({
    id: Uuid,
    direction: z.enum(MESSAGE_DIRECTIONS),
    kind: z.enum(['TEXT', 'TEMPLATE', 'ASSISTANT', 'OTHER']),
    body: z.string(),
    status: z.enum(INBOX_MESSAGE_STATUSES),
    sentBy: z.string().nullable(),
    createdAt: Instant,
  })
  .meta({ id: 'ThreadMessage' });

const COMMON = {
  tags: ['Messaging'],
  propertyScoped: true as const,
  permission: 'message.send',
};
const ThreadParams = z.object({ threadId: Uuid });

export const listMessageThreads = defineRoute({
  ...COMMON,
  operationId: 'listMessageThreads',
  method: 'get',
  path: '/message-threads',
  summary: 'WhatsApp conversations, most recent first (M11-04)',
  query: z.object({ unread: z.stringbool().optional() }),
  response: z.object({ data: z.array(ThreadItem) }),
});

export const getMessageThread = defineRoute({
  ...COMMON,
  operationId: 'getMessageThread',
  method: 'get',
  path: '/message-threads/{threadId}',
  summary: 'One conversation with its latest messages',
  params: ThreadParams,
  response: ThreadItem.extend({ messages: z.array(ThreadMessage) }),
});

export const sendThreadMessage = defineRoute({
  ...COMMON,
  operationId: 'sendThreadMessage',
  method: 'post',
  path: '/message-threads/{threadId}/messages',
  summary: 'Reply to a guest in free text, within the 24-hour window',
  description:
    '409 STATE_TRANSITION_INVALID with `details.reason = WINDOW_CLOSED` when the guest last wrote more than 24 hours ago: send the follow-up template instead. A provider failure comes back as a message with status FAILED.',
  idempotent: true,
  status: 201,
  params: ThreadParams,
  body: z.object({ body: z.string().trim().min(1).max(4096) }),
  response: ThreadMessage,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const sendThreadFollowUp = defineRoute({
  ...COMMON,
  operationId: 'sendThreadFollowUp',
  method: 'post',
  path: '/message-threads/{threadId}/follow-up',
  summary: 'Send the approved template that invites the guest to reply',
  description: 'For use outside the 24-hour window, when free text cannot reach the guest.',
  idempotent: true,
  status: 201,
  params: ThreadParams,
  body: z.object({}),
  response: ThreadMessage,
});

export const markThreadRead = defineRoute({
  ...COMMON,
  operationId: 'markThreadRead',
  method: 'post',
  path: '/message-threads/{threadId}/read',
  summary: 'Mark a conversation as read',
  params: ThreadParams,
  body: z.object({}),
  response: z.object({ unreadCount: z.literal(0) }),
});

export const setThreadAssistant = defineRoute({
  ...COMMON,
  operationId: 'setThreadAssistant',
  method: 'post',
  path: '/message-threads/{threadId}/assistant',
  summary: 'Take a conversation over from the assistant, or hand it back (T-117)',
  params: ThreadParams,
  body: z.object({ active: z.boolean() }),
  response: ThreadItem,
});

export const INBOX_ROUTES = {
  setThreadAssistant,
  listMessageThreads,
  getMessageThread,
  sendThreadMessage,
  sendThreadFollowUp,
  markThreadRead,
} as const;
