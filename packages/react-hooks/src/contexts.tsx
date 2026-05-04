"use client";

import React from "react";
import { createContextAndHook } from "./utils/createContextAndHook.js";
import type { ApiClientConfiguration } from "@platos/core/v3";

const [TriggerAuthContext, useTriggerAuthContext, useTriggerAuthContextOptional] =
  createContextAndHook<ApiClientConfiguration>("TriggerAuthContext");

export { TriggerAuthContext, useTriggerAuthContext, useTriggerAuthContextOptional };
