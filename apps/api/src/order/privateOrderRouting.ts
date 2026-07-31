export const PRIVATE_TEST_ORDER_TG_USER_ID = 1208488286;
export const PRIVATE_TEST_ORDER_CHAT_ID = String(PRIVATE_TEST_ORDER_TG_USER_ID);
export const GLOBAL_ORDER_CHAT_ID_TO_HIDE_PRIVATE_TEST_ORDERS = 815653720;

export function isPrivateTestOrderUser(tgUserId: number | null | undefined): boolean {
  return tgUserId === PRIVATE_TEST_ORDER_TG_USER_ID;
}

export function pickPrivateTestOrderChatIds(tgUserId: number | null | undefined): string[] | null {
  return isPrivateTestOrderUser(tgUserId) ? [PRIVATE_TEST_ORDER_CHAT_ID] : null;
}

export function shouldHidePrivateTestOrderFromChat(params: {
  tgUserId: number | null | undefined;
  chatId: string | number;
}): boolean {
  if (!isPrivateTestOrderUser(params.tgUserId)) return false;
  return Number(params.chatId) === GLOBAL_ORDER_CHAT_ID_TO_HIDE_PRIVATE_TEST_ORDERS;
}
