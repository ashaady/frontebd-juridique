"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useEffect, useRef } from "react";
import {
  registerWorkspaceUserApi,
  setWorkspaceAuthToken,
  setWorkspaceUserContext,
} from "../_lib/workspace-api";

function normalizeSignaturePart(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function WorkspaceUserSync() {
  const { getToken, isLoaded: isAuthLoaded, isSignedIn, userId } = useAuth();
  const { user } = useUser();
  const lastSyncedSignatureRef = useRef("");

  useEffect(() => {
    if (!isAuthLoaded) {
      return;
    }

    if (!isSignedIn) {
      setWorkspaceAuthToken(null);
      setWorkspaceUserContext(null);
      lastSyncedSignatureRef.current = "";
      return;
    }

    const context = {
      userId: userId ?? null,
      email: user?.primaryEmailAddress?.emailAddress ?? null,
      displayName: user?.fullName ?? user?.firstName ?? null,
      username: user?.username ?? null,
    };

    setWorkspaceUserContext(context);

    const syncSignature = [
      normalizeSignaturePart(context.userId),
      normalizeSignaturePart(context.email),
      normalizeSignaturePart(context.displayName),
      normalizeSignaturePart(context.username),
    ].join("|");

    if (!context.userId || syncSignature === lastSyncedSignatureRef.current) {
      return;
    }
    lastSyncedSignatureRef.current = syncSignature;
    void (async () => {
      setWorkspaceAuthToken(await getToken());
      await registerWorkspaceUserApi();
    })();
  }, [
    getToken,
    isAuthLoaded,
    isSignedIn,
    userId,
    user?.primaryEmailAddress?.emailAddress,
    user?.fullName,
    user?.firstName,
    user?.username,
  ]);

  return null;
}
