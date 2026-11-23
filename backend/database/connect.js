import { MongoClient } from 'mongodb'
import { getConfig } from '../config/environment.js'

let clientConnection

function connectToClient() {
    if (clientConnection) return clientConnection

    clientConnection = Promise.resolve().then(async () => {
        const { mongodbUri } = getConfig()
        const client = new MongoClient(mongodbUri, {
            serverSelectionTimeoutMS: 5000
        })
        try {
            await client.connect()
            return client
        } catch (error) {
            await client.close()
            throw error
        }
    }).catch(error => {
        clientConnection = undefined
        throw error
    })

    return clientConnection
}

export async function connectToDatabase(databaseName) {
    if (!databaseName) {
        throw new Error('A MongoDB database name is required')
    }

    const client = await connectToClient()
    return client.db(databaseName)
}
