<script setup>
import { RouterView } from 'vue-router'
</script>

<template>
  <RouterView />
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

html, body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background-color: #1a1a1a;
  font-family: Arial, sans-serif;
}

#app {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
</style>