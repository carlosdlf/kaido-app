import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist/wght-italic.css";
import "$lib/ui/tokens.css";
import "$lib/ui/base.css";
import { mount } from "svelte";
import App from "./App.svelte";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app mount element");

export default mount(App, { target });
