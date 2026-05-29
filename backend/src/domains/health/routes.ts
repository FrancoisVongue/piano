import express from 'express'

export const HealthRouter = express.Router()

HealthRouter.get('/', (req: express.Request, res: express.Response) => {
  res.json({ 
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'piano-backend'
  })
})
