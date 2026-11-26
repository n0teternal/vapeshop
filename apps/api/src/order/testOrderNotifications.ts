// The owner's account is used to exercise the real checkout flow. Its test
// orders must never reach staff, city, owner or status chats.
export const TEST_ORDER_TG_USER_ID = 1208488286;

export function isPrivateTestOrder(tgUserId: number): boolean {
  return tgUserId === TEST_ORDER_TG_USER_ID;
}

export function privateTestOrderChatIds(): string[] {
  return [String(TEST_ORDER_TG_USER_ID)];
}
