import * as d3 from 'd3'
import _ from 'lodash'
import SizedArray from './sizedArray'

const startOfSecond = (d) => {
  const date = new Date(d)
  date.setMilliseconds(0)
  return date
}

export default class StreamChart {
  constructor(options) {
    this.container = document.querySelector(options.selector)
    if (!this.container) return

    this.xVariable = options.x
    this.yVariable = options.y
    this.transition = options.transition
    this.maxSize = options.maxSize
    this.maxDisplaySize = options.maxDisplaySize

    const svg = d3
      .select(this.container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')

    const chartArea = svg.append('g').attr('transform', 'translate(0, 0)')

    this.clipPath = chartArea
      .append('defs')
      .append('clipPath')
      .attr('id', 'clip')
      .append('rect')

    this.chartArea = chartArea.append('g').attr('clip-path', 'url(#clip)')
    this.xAxisG = chartArea.append('g').attr('class', 'x-axis')

    // The first points need to be rendered outside the x axis
    const rightEdge = 3
    this.xScale = d3
      .scaleLinear()
      .domain([this.maxDisplaySize + rightEdge, rightEdge])
    this.yScale = d3.scaleLinear()

    this.xAxis = d3
      .axisBottom()
      .tickValues(_.range(rightEdge, this.maxDisplaySize + rightEdge + 1, 15))
      .tickFormat((d) => {
        const seconds = d - rightEdge
        return `${seconds}s`
      })
      .scale(this.xScale)

    this.line = d3
      .line()
      .x((d, index, items) => {
        const last = index === items.length - 1
        // Force the first data point to always line up with the right edge
        const secondsAgo = last
          ? 0
          : Math.floor((new Date() - d[this.xVariable]) / 1000)
        return this.xScale(secondsAgo)
      })
      .y((d) => {
        return this.yScale(d[this.yVariable])
      })
      .curve(d3.curveBasis)
  }

  getHeight() {
    return this.container.clientHeight
  }

  getWidth() {
    return this.container.clientWidth
  }

  formatData(raw) {
    return Object.assign({}, raw, {
      [this.xVariable]: startOfSecond(raw[this.xVariable])
    })
  }

  init() {
    if (!this.container) return
    this._lastData = new SizedArray(this.maxSize)

    this.updateScaleAndAxesData({ first: true })
    this.updateScales({ first: true })
    this.updateAxes({ first: true })
    this.updateLine({ first: true })
    d3.select(this.container).classed('loading', false)

    window.addEventListener('resize', () => this.resize())
    this._initialized = true
  }

  resize() {
    this.updateScaleAndAxesData()
    this.updateScales()
    this.updateAxes()
    this.updateLine()
  }

  update(data) {
    if (!this.container) return

    if (!this._initialized) return

    const fmtData = this.formatData(data)
    if (fmtData === null) {
      return
    }

    this._lastData.push(fmtData)

    this.updateScaleAndAxesData({ transition: this.transition })
    this.updateScales({ transition: this.transition })
    this.updateAxes({ transition: this.transition })
    this.updateLine({ transition: this.transition })
  }

  updateScaleAndAxesData() {
    const max = d3.max(this._lastData.items(), (d) => d[this.yVariable])
    this.yScale.domain([0, max]).nice()
  }

  updateScales() {
    this.xScale.range([0, this.getWidth()])
    this.yScale.range([this.getHeight(), 0])
  }

  updateAxes() {
    this.clipPath
      .attr('width', this.getWidth())
      .attr('height', this.getHeight())

    this.xAxisG
      .attr('transform', `translate(0, ${this.getHeight() + 15})`)
      .call(this.xAxis)

    this.xAxisG
      .selectAll('text')
      .nodes()
      .map((node, index, nodes) => {
        if (index === 0) {
          node.setAttribute('style', 'text-anchor: end')
        } else if (index === nodes.length - 1) {
          node.setAttribute('style', 'text-anchor: start')
        }
      })
  }

  updateLine(options = {}) {
    const data = this._lastData.items()

    if (data.length === 0) return

    const updateSelection = this.chartArea.selectAll('.chart-path').data([data])

    const enterSelection = updateSelection
      .enter()
      .append('path')
      .attr('class', (__, index) => `chart-path chart-line-color-${index + 1}`)

    updateSelection.exit().remove()

    enterSelection
      .merge(updateSelection)
      .transition()
      .duration(options.transition || 0)
      .ease(d3.easeLinear)
      .on('start', (d, index, nodes) => {
        const node = nodes[index]

        d3.select(node)
          .attr('d', this.line)
          .attr('transform', null)

        d3.active(node).attr(
          'transform',
          `translate(${this.xScale(this.xScale.domain()[0] + 1)},0)`
        )
      })
  }
}
