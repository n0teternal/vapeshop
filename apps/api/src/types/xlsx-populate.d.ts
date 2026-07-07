declare module "xlsx-populate" {
  type WorkbookOutputType =
    | "base64"
    | "binarystring"
    | "uint8array"
    | "arraybuffer"
    | "blob"
    | "nodebuffer"
    | "buffer";

  type WorkbookOutput = Buffer | Uint8Array | ArrayBuffer | string;

  type Workbook = {
    outputAsync(options?: {
      type?: WorkbookOutputType;
      password?: string;
    }): Promise<WorkbookOutput>;
  };

  const XlsxPopulate: {
    fromDataAsync(
      data: Buffer | Uint8Array | ArrayBuffer,
      options?: { password?: string },
    ): Promise<Workbook>;
  };

  export default XlsxPopulate;
}
