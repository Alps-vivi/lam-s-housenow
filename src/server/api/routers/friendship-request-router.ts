/* eslint-disable prettier/prettier */
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { FriendshipStatusSchema } from '@/utils/server/friendship-schemas'
import { authGuard } from '@/server/trpc/middlewares/auth-guard'
import { procedure } from '@/server/trpc/procedures'
import { IdSchema } from '@/utils/server/base-schemas'
import { router } from '@/server/trpc/router'

const SendFriendshipRequestInputSchema = z.object({
  friendUserId: IdSchema,
})

const canSendFriendshipRequest = authGuard.unstable_pipe(
  async ({ ctx, rawInput, next }) => {
    const { friendUserId } = SendFriendshipRequestInputSchema.parse(rawInput)

    await ctx.db
      .selectFrom('users')
      .where('users.id', '=', friendUserId)
      .select('id')
      .limit(1)
      .executeTakeFirstOrThrow(
        () =>
          new TRPCError({
            code: 'BAD_REQUEST',
          })
      )

    return next({ ctx })
  }
)

const AnswerFriendshipRequestInputSchema = z.object({
  friendUserId: IdSchema,
})

const canAnswerFriendshipRequest = authGuard.unstable_pipe(
  async ({ ctx, rawInput, next }) => {
    const { friendUserId } = AnswerFriendshipRequestInputSchema.parse(rawInput)

    await ctx.db
      .selectFrom('friendships')
      .where('friendships.userId', '=', friendUserId)
      .where('friendships.friendUserId', '=', ctx.session.userId)
      .where(
        'friendships.status',
        '=',
        FriendshipStatusSchema.Values['requested']
      )
      .select('friendships.id')
      .limit(1)
      .executeTakeFirstOrThrow(() => {
        throw new TRPCError({
          code: 'BAD_REQUEST',
        })
      })

    return next({ ctx })
  }
)

export const friendshipRequestRouter = router({
  send: procedure
    .use(canSendFriendshipRequest)
    .input(SendFriendshipRequestInputSchema)
    .mutation(async ({ ctx, input }) => {
      // 1. Xóa yêu cầu kết bạn cũ nếu có với trạng thái 'declined'
      await ctx.db
      .deleteFrom('friendships')
      .where('userId', '=', ctx.session.userId)
      .where('friendUserId', '=', input.friendUserId)
      .where('status', '=', FriendshipStatusSchema.Values['declined'])
      .execute();

      // 2. Thực hiện thêm yêu cầu kết bạn mới
      return ctx.db
        .insertInto('friendships')
        .values({
          userId: ctx.session.userId,
          friendUserId: input.friendUserId,
          status: FriendshipStatusSchema.Values['requested'],
        })
        .execute()
    }),

  accept: procedure
    .use(canAnswerFriendshipRequest)
    .input(AnswerFriendshipRequestInputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction().execute(async (t) => {
        // 1. Cập nhật yêu cầu kết bạn hiện tại để có trạng thái accepted
        await t
          .updateTable('friendships')
          .set({
            status: FriendshipStatusSchema.Values['accepted'],
          })
          .where('userId', '=', input.friendUserId)
          .where('friendUserId', '=', ctx.session.userId)
          .execute()

        // 2. Tạo một bản ghi kết bạn mới với người dùng ngược lại và trạng thái accepted
        await t
          .insertInto('friendships')
          .values({
            userId: ctx.session.userId,
            friendUserId: input.friendUserId,
            status: FriendshipStatusSchema.Values['accepted'],
          })
          .onConflict((oc) => //chuyển đổi trạng thái thnafh accepted nếu đã có bản ghi đảo ngược
            oc.columns(['userId', 'friendUserId']).doUpdateSet({
              status: FriendshipStatusSchema.Values['accepted'],
            })
          )
          .execute()
      })
    }),

  decline: procedure
    .use(canAnswerFriendshipRequest)
    .input(AnswerFriendshipRequestInputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.db.transaction().execute(async (t) => {
        // Cập nhật trạng thái yêu cầu thành declined
        await t
          .updateTable('friendships')
          .set({
            status: FriendshipStatusSchema.Values['declined'],
          })
          .where('friendships.userId', '=', input.friendUserId)
          .where('friendships.friendUserId', '=', ctx.session.userId)
          .where('friendships.status', '=', FriendshipStatusSchema.Values['requested'])
          .execute()
      })
    }),
})
