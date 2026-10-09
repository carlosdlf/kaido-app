import "@fontsource-variable/jetbrains-mono";
import "$lib/ui/tokens.css";
import "$lib/ui/base.css";
import { mount } from "svelte";
import { createCaptureChannel } from "$lib/storage";
import Capture from "$lib/ui/Capture.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app mount element");

export default mount(Capture, { target, props: { channel: createCaptureChannel() } });
