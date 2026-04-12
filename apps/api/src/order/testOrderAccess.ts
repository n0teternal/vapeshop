export const TEST_ORDER_SELF_CHAT_ID = "1208488286";
export const ORDER_EDIT_TEST_TG_USER_ID = 1208488286;

export function isSelfOnlyTestOrderUser(tgUserId: number | null | undefined): boolean {
  return typeof tgUserId === "number" && String(tgUserId) === TEST_ORDER_SELF_CHAT_ID;
}

export function canUseOrderEditing(tgUserId: number | null | undefined): boolean {
  return tgUserId === ORDER_EDIT_TEST_TG_USER_ID;
}
