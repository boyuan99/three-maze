<template>
  <div ref="container"></div>
</template>

<script>
import * as THREE from 'three'
import axios from 'axios'

export default {
  name: 'ApiControlledCube',
  mounted() {
    const container = this.$refs.container

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(
      75,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    )

    this.renderer = new THREE.WebGLRenderer()
    this.renderer.setSize(container.clientWidth, container.clientHeight)
    container.appendChild(this.renderer.domElement)

    const geometry = new THREE.BoxGeometry()
    const material = new THREE.MeshNormalMaterial({  })
    this.cube = new THREE.Mesh(geometry, material)
    this.scene.add(this.cube)

    this.camera.position.z = 5

    this.animate()
    this.fetchRotation()
    window.addEventListener("resize", this.onWindowResize, false);
  },
  methods: {
    animate() {
      requestAnimationFrame(this.animate)
      this.renderer.render(this.scene, this.camera)
    },

    fetchRotation() {
      axios
        .get('/api/rotation')
        .then((response) => {
          const { x, y, z } = response.data
          this.cube.rotation.x = x
          this.cube.rotation.y = y
          this.cube.rotation.z = z
          // Get new rotation parameters at regular intervals
          setTimeout(this.fetchRotation, 100)
        })
        .catch((error) => {
          console.error(error)
        })
    },

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    },
  },
}

</script>

<style scoped>
div {
  width: 100vw;
  height: 100vh;
}
</style>
