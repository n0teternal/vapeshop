export const ORDER_EDIT_TEST_TG_USER_ID = 1208488286;

export function readTelegramUserId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

export function canUseOrderEditing(tgUserId: number | null | undefined): boolean {
  return tgUserId === ORDER_EDIT_TEST_TG_USER_ID;
}
