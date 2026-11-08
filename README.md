# Aether ⚡ Distributed Event-Driven Task Scheduler & Visualizer

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)

**Aether** is a high-performance, distributed event-driven task scheduling engine and real-time monitoring dashboard designed to process asynchronous background jobs with configurable retry policies, dead-letter queue (DLQ) handling, and WebSocket-based metrics streaming.

---

## 🏗 System Architecture

Aether decouples task ingestion from execution using Redis streams/queues, providing fault tolerance, horizontal worker scalability, and low-latency status updates.
