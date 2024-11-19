<template>
  <nav class="navigation">
    <div class="nav-content">
      <router-link to="/" class="nav-link">Main Gallery</router-link>
      <router-link to="/physics-mazes" class="nav-link"> Mazes</router-link>
    </div>
  </nav>
</template>

<style scoped>
.navigation {
  background-color: #1a1a1a;
  padding: 1rem 0;
  position: fixed;
  top: 0;
  width: 100%;
  z-index: 1000;
}

.nav-content {
  max-width: 1200px;

  margin: 0 auto;
  display: flex;
  gap: 2rem;
  padding: 0 2rem;
}

.nav-link {
  color: white;
  text-decoration: none;
  font-size: 1.1rem;
  padding: 0.5rem 1rem;
  border-radius: 4px;
  transition: background-color 0.3s ease;
}

.nav-link:hover {
  background-color: #333;
}

.router-link-active {
  background-color: #333;
}
</style> 