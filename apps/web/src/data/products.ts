export type Product = {
  id: string;
  title: string;
  price: number;
  inStock: boolean;
};

export const PRODUCTS: Product[] = [
  { id: "p-001", title: "Товар №1", price: 490, inStock: true },
  { id: "p-002", title: "Товар №2", price: 690, inStock: true },
  { id: "p-003", title: "Товар №3", price: 1290, inStock: true },
  { id: "p-004", title: "Товар №4", price: 990, inStock: true },
  { id: "p-005", title: "Товар №5", price: 1790, inStock: true },
  { id: "p-006", title: "Товар №6", price: 2990, inStock: true },
];

