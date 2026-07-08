"use client";

import { type ReactNode } from "react";

interface PipecatProviderProps {
	children: ReactNode;
}

export function PipecatProvider({ children }: PipecatProviderProps) {
	return <>{children}</>;
}
