# Holodeck Examples

This directory contains example files and tutorials for using Holodeck to create 3D infrastructure visualizations.

## 🚀 Quick Start

### Prerequisites

1. **Install Dependencies**: Make sure you're in the holodeck repository root and install dependencies:
   ```bash
   pnpm install
   ```

2. **Build the CLI**: Build the CLI package:
   ```bash
   pnpm run build
   ```

### Example 1: Simple AWS Infrastructure

Generate a 3D scene from a Brainboard SVG:

```bash
# Generate scene file
pnpm holodeck generate \
  --input examples/brainboard-svgs/simple-aws-infrastructure.svg \
  --output aws-scene.json

# Start development server
pnpm holodeck dev \
  --input examples/brainboard-svgs/simple-aws-infrastructure.svg \
  --port 3000 \
  --open
```

This example shows:
- **EC2 instances** (web servers) in multiple availability zones
- **Application Load Balancer** distributing traffic
- **RDS PostgreSQL database** with Multi-AZ setup
- **S3 bucket** for asset storage
- **Lambda function** for image processing
- **VPC networking** with proper connections

### Example 2: Microservices Architecture

```bash
# Generate and serve microservices diagram
pnpm holodeck dev \
  --input examples/brainboard-svgs/microservices-architecture.svg \
  --port 3001 \
  --editor
```

This example demonstrates:
- **API Gateway** as the entry point
- **Microservices** (User, Order, Payment services)
- **Multiple databases** (PostgreSQL, MongoDB, Redis)
- **Service connections** with proper data flow

## 📁 Available Examples

### Brainboard SVG Examples

| File | Description | Components |
|------|-------------|------------|
| `simple-aws-infrastructure.svg` | Basic AWS setup with web tier and database | EC2, RDS, S3, Lambda, ALB |
| `microservices-architecture.svg` | Microservices with API Gateway | Services, Databases, API Gateway |

## 🎨 Creating Your Own Examples

### From Brainboard

1. **Export from Brainboard**: In Brainboard, export your diagram as SVG
2. **Save to examples**: Place the SVG file in `examples/brainboard-svgs/`
3. **Test import**: Use the CLI to generate a scene:
   ```bash
   pnpm holodeck generate --input your-diagram.svg --output test-scene.json
   ```
4. **View in dev server**:
   ```bash
   pnpm holodeck dev --input your-diagram.svg
   ```

### SVG Requirements

For best results, your SVG should:

- **Use semantic IDs**: Name elements with descriptive IDs like `ec2-web-server-1`, `rds-main-db`
- **Include classes**: Add CSS classes that indicate service types: `ec2 server`, `rds database`, `s3 storage`
- **Proper grouping**: Use `<g>` elements to group related components
- **Text labels**: Include `<text>` elements or `<title>` tags for service names
- **Clear connections**: Use `<line>` or `<path>` elements for service connections

### Example SVG Structure

```xml
<svg>
  <!-- Service with semantic ID and classes -->
  <g id="ec2-web-server-1" class="ec2 server" transform="translate(100, 100)">
    <rect width="80" height="60" fill="#FF9800"/>
    <text x="40" y="30">Web Server</text>
  </g>

  <!-- Database with proper naming -->
  <g id="rds-main-db" class="rds database" transform="translate(300, 100)">
    <rect width="100" height="60" fill="#3F51B5"/>
    <text x="50" y="30">PostgreSQL</text>
  </g>

  <!-- Connection between services -->
  <line id="connection-web-db" x1="180" y1="130" x2="300" y2="130"
        stroke="#666" class="connection database"/>
</svg>
```

## 🛠 CLI Commands

### Generate Scene Files

```bash
# Basic generation
pnpm holodeck generate --input diagram.svg

# Custom output and layout
pnpm holodeck generate \
  --input diagram.svg \
  --output custom-scene.json \
  --layout grid \
  --spacing 10

# Watch for changes
pnpm holodeck generate --input diagram.svg --watch
```

### Development Server

```bash
# Basic dev server
pnpm holodeck dev --input diagram.svg

# Custom port and host
pnpm holodeck dev --input diagram.svg --port 8080 --host 0.0.0.0

# Editor mode with auto-open
pnpm holodeck dev --input diagram.svg --editor --open
```

## 🌐 Accessing Your Scenes

When running the dev server, you can access:

- **Main UI**: `http://localhost:3000` - Beautiful development dashboard
- **Scene JSON**: `http://localhost:3000/api/scene` - Raw scene data for debugging
- **Auto-reload**: The server automatically reloads when input files change

## 🎯 Next Steps

1. **Try the examples** above to understand the workflow
2. **Create your own SVG** diagrams in Brainboard or draw.io
3. **Explore the generated scenes** by examining the JSON output
4. **Integrate with React Three Fiber** using the `@holodeck/builder-three` package (coming soon)
5. **Add live metrics** using provider packages (OTEL, Datadog, etc.)

## 🤝 Contributing Examples

Have a great example? We'd love to include it! Please:

1. **Create a pull request** with your SVG file and description
2. **Include documentation** explaining what the diagram represents
3. **Test thoroughly** to ensure it imports correctly
4. **Follow naming conventions** for services and connections

---

**Need help?** Check out the main [Holodeck README](../README.md) or open an issue on GitHub.
