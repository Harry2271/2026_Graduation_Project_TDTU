"use client";

import { useState } from "react";
import { Provider } from "react-redux";
import { makeStore } from "../store";
import type { AppStore } from "../store";

export default function StoreProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // Sử dụng useState thay vì useRef để tránh lỗi của React Compiler
  // khi access vào .current trong quá trình render.
  const [storeInstance] = useState<AppStore>(() => makeStore());

  return <Provider store={storeInstance}>{children}</Provider>;
}
